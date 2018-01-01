const _ = require('lodash');
const app = require('commander')
const archiver = require('archiver')
const exec = require('child_process').exec
const fs = require('fs')
const glob = require('glob')
const md5 = require('md5')
const openwhisk = require('openwhisk')
const path = require('path')
const PropertiesReader = require('properties-reader')
const Promise = require('bluebird');
const winston = require('winston')

app
  .version("1.0.0")
  .option("-d, --dir <directory>", "The root directory of the actions to be deployed. Defaults to '.' (current directory)")
  .option("--package-include-pattern <pattern>", "A glob pattern to select the actions within the package directory. Default './*'")
  .option("--ow-apihost <hostname>", "The OpenWhisk API hostname. Overrides ${__OW_API_HOST} and settings from ~/.wskprops.")
  .option("--ow-apikey <apikey>", "The OpenWhisk API key. Overrides ${__OW_API_KEY} and settings from ~/.wskprops.")
  .option("--ow-apitoken <apitoken>", "The OpenWhisk API authorization token. Overrides ${__OW_APIGW_KEY} and settings from ~/.wskprops.")
  .parse(process.argv);

/**
 * Configures environment variables to properly initialize openwhisk.
 */
const initialize_openwhisk_configuration = () => {
  const wskprops_path = require('os').homedir() + "/.wskprops";
  var properties;

  if (fs.existsSync(wskprops_path)) {
    properties = PropertiesReader(wskprops_path);
  } else {
    // mock properties
    properties = { get: () => { } }
  }

  process.env["__OW_API_HOST"] = app.owApihost || process.env["__OW_API_HOST"] || properties.get("APIHOST")
  process.env["__OW_API_KEY"] = app.owApikey || process.env["__OW_API_KEY"] || properties.get("AUTH")
  process.env["__OW_APIGW_TOKEN"] = app.owApitoken || process.env["__OW_APIGW_TOKEN"] || properties.get("APIGW_ACCESS_TOKEN")
}

/**
 * Reads a JSON file, returns a default value if file does not exist.
 * 
 * @param {string} path 
 * @param {object} defaultValue 
 */
const read_json = (path, defaultValue = {}) => {
  if (fs.existsSync(path) && fs.lstatSync(path).isFile()) {
    const json = JSON.parse(fs.readFileSync(path, "utf-8"));
    return json;
  } else {
    return defaultValue;
  }
}

/**
 * Checks the package configuration as described in `pkg`. Changes the package configuration according 
 * to `pkg`.
 * 
 * `pkg` is an object which may have the following values:
 * 
 * ```
 * {
 *   "name": "<package_name>",
 *   "publish": true
 * }
 * ```
 * @param {object} pkg 
 */
const check_package = (pkg = {}) => {
  const ow = openwhisk()

  return ow.packages.create({
    name: pkg.name,
    overwrite: true,
    package: _.omit(pkg, 'name')
  }).then(result => {
    winston.info(`created/ updated package "${pkg.name}"\n${JSON.stringify(result, null, 2)}`)
    return result;
  });
}

const check_action$npm_install = (action = {}, directory) => {
  return new Promise((resolve, reject) => {
    // execute npm install within directory
    exec('npm install', { cwd: directory }, (error, stdout, stderr) => {
      winston.info(`Executed 'npm install' for ${action.name} ...`)
      winston.debug(`stdout:\n${stdout}`)
      winston.debug(`stderr:\n${stderr}`)

      resolve();
    })
  })
}

const check_action$create_archive = (action = {}, directory) => {
  return new Promise((resolve, reject) => {
    try {
      const archive_path = path.resolve(directory, `../${action.name}.zip`);

      if (fs.existsSync(archive_path)) {
        winston.debug(`Deleting existing version of '${archive_path}'`);
        fs.unlinkSync(archive_path);
      }

      const archive_stream = fs.createWriteStream(archive_path);
      const archive = archiver('zip', { zlib: { level: 9 } });
      const files_pattern = action.files_pattern || "**";

      winston.info(`Creating zip archive for '${action.name}' with glob pattern '${files_pattern}' into ZIP-file ${archive_path}.`)

      archive_stream.on('close', () => resolve(archive_path));
      archive.pipe(archive_stream);
      archive.glob(files_pattern, { cwd: directory }, { prefix: "" })
      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}

const check_action$update_action$check_existing = (action = {}, package_name, archive_path) => {
  const md5sum = md5(fs.readFileSync(archive_path))
  winston.info(`md5 checksum of '${archive_path}': ${md5sum}`)
  winston.info(`Check existence of ${package_name}/${action.name} ...`)

  return openwhisk().actions.get(`${package_name}/${action.name}`)
    .then(result => {
      // action already exists, check checksum
      console.log(_.omit(result, 'exec'))

      const existing_annotations = _.groupBy(_.get(result, 'annotations', []), 'key');
      const existing_md5sum = _.get(existing_annotations, 'md5sum.value', 'n/a');

      console.log(`existing md5 checksum of ${package_name}/${action.name}: ${existing_md5sum}`)

      return {
        action: result,
        update: !_.isEqual(existing_md5sum, md5sum),
        md5sum
      }
    })
    .catch(error => {
      return {
        update: true,
        md5sum
      };
    });
}

const check_action$update_action$update = (action = {}, directory, package_name, archive_path, exists = {}) => {
  if (exists.update) {
    winston.info(`Uploading '${archive_path}' to action '${package_name}/${action.name}' ...`)
    const ow = openwhisk();
    const action_file = fs.readFileSync(archive_path);

    return ow.actions.create({
      name: `${package_name}/${action.name}`,
      overwrite: true,
      action: action_file
    }).then(action_result => {
      winston.info("Done uploading.");
      winston.info("Updating package information ...");
      const options = _.assign({}, action);
      const annotations = _.concat(_.get(action_result, 'annotations', []), _.get(options, 'annotations', []));
      _.set(options, 'annotations', _.concat(annotations, [{ key: 'md5sum', value: exists.md5sum }]));

      return ow.actions.update({
        name: `${package_name}/${action.name}`,
        overwrite: true,
        action: _.omit(options, 'name')
      });
    }).then(action_result => {

      return action_result;
    })
  } else {
    return Promise.resolve(exists.action);
  }
}

const check_action$update_action = (action = {}, directory, package_name, archive_path) => {
  return Promise.resolve()
    .then(() => check_action$update_action$check_existing(action, package_name, archive_path))
    .then(exists => check_action$update_action$update(action, directory, package_name, archive_path, exists))
}

/**
 * 
 * @param {*} action 
 */
const check_action = (action = {}, directory, package_name) => {
  return Promise.resolve()
    .then(() => check_action$npm_install(action, directory))
    .then(() => check_action$create_archive(action, directory))
    .then((archive_path) => check_action$update_action(action, directory, package_name, archive_path));
}

/**
 * Checks the given directory and creates the according package and actions of it.
 * 
 * @param {string} directory 
 */
const check_package_from_dir = (directory) => {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) {
    const default_packagename = path.basename(directory);
    const package_info_file = path.resolve(directory, './openwhisk.package.json');
    const package_info = _.assign({ name: default_packagename }, read_json(package_info_file));

    return check_package(package_info)
      .then(({ name }) => {
        winston.info(`Start creating actions for package '${name}' ...`);
        return check_actions_from_dir(work_dir, name);
      });
  } else {
    throw new Error(`The directory ${directory} does not exist or is not a directory.`)
  }
}

/**
 * Checks the given path if it is a action directory. If it is an action, the action will be created.
 * 
 * @param {string} directory 
 */
const check_action_from_dir = (directory, package_name) => {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) {
    const default_actionname = path.basename(directory);
    const action_info_file = path.resolve(directory, './openwhisk.action.json');
    const action_info = _.assign({ name: default_actionname }, read_json(action_info_file));
    winston.info(`Creating action '${action_info.name}' ...`)
    return check_action(action_info, directory, package_name);
  } else {
    return Promise.resolve()
  }
}

const check_actions_from_dir = (directory, package_name) => {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) {
    const files = fs.readdirSync(directory);
    return new Promise((resolve, reject) => {
      glob(app.packageIncludePattern || "./*", { cwd: directory }, (err, files = []) => {
        resolve(Promise.all(_.map(files, file => check_action_from_dir(path.resolve(directory, file), package_name))))
      });
    });
  } else {
    return Promise.reject(new Error(`The directory ${directory} does not exist or is not a directory.`))
  }
}

const work_dir = path.resolve(process.cwd(), app.dir || process.cwd())

initialize_openwhisk_configuration();

Promise.resolve()
  .then(() => check_package_from_dir(work_dir))
  .then(result => {
    console.log("DONE")
  });