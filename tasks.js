const _ = require('lodash')
const archiver = require('archiver')
const exec = require('child_process').exec
const fs = require('fs')
const md5 = require('md5')
const openwhisk = require('openwhisk')
const path = require('path')
const PropertiesReader = require('properties-reader')
const winston = require('winston')
const utils = require('./utils').default;

/**
 * Creates a ZIP file.
 * 
 * @param {*} directory The directory which should be zipped.
 * @param {*} zip_file The ZIP file which should be created.
 * @param {*} ignorelist Files to be ignored.
 */
const create_zip_archive = (directory, zip_file, ignorelist = []) => {
  return new Promise((resolve, reject) => {
    try {
      const files = utils.read_filelist(directory, ignorelist, 'f');
      const archive_stream = fs.createWriteStream(zip_file);
      const archive = archiver('zip', { zlib: { level: 9 } });

      winston.info(`Creating zip archive '${zip_file}.`);

      archive_stream.on('close', () => {
        winston.info(`Zip archive '${zip_file} created.'`)
        resolve(zip_file)
      });
      archive.pipe(archive_stream);

      _.each(files, file => {
        const file_path = path.resolve(directory, file);
        archive.append(fs.createReadStream(file_path), { name: file })
      });

      archive.finalize();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * 
 * @param {*} directory 
 */
const create_md5sum = (directory, ignorelist = []) => {
  const files = utils.read_filelist(directory, ignorelist, 'f', true);

  const files_hash = _.reduce(files, (hash, file) => {
    const file_path = path.resolve(directory, file);
    const file_hash = md5(fs.readFileSync(file_path));

    return `${hash}${file_hash}`;
  }, '');

  const hash = md5(files_hash);
  winston.info(`${directory} hash: ${hash}`);
  return Promise.resolve(hash);
}

/**
 * Configures environment variables to properly initialize openwhisk.
 */
const initialize_openwhisk_configuration = (app) => {
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

  return Promise.resolve();
}

/**
 * Executes `npm install` in a directory.
 * @param {*} action 
 * @param {*} directory 
 */
const npm_install = (directory) => {
  return new Promise((resolve, reject) => {
    winston.info(`Execute 'npm install' for ${directory} ...`)
    exec('npm install --only=production', { cwd: directory }, (error, stdout, stderr) => {
      winston.info(`Executed 'npm install --only=production' in directory ${directory}.`)
      winston.debug(`stdout:\n${stdout}`)
      winston.debug(`stderr:\n${stderr}`)
      resolve();
    })
  })
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
const openwhisk$create_package = (pkg = {}) => {
  const ow = openwhisk()

  return ow.packages.create({
    name: pkg.name,
    overwrite: true,
    package: _.omit(pkg, 'name')
  }).then(result => {
    winston.info(`created/updated openwhisk package '${pkg.name}'`)
    return result;
  });
}

/**
 * Checks whether an action needs to be uploaded/ updated based on the existence of the action
 * and its md5 checksum.
 * 
 * @param {object} action         Must include 'name' and 'md5sum'
 * @param {string} package_name   The name of the package
 */
const openwhisk$check_existing_action = (action = {}, package_name) => {
  winston.info(`Fetching information for '${package_name}/${action.name}' ...`)
  return openwhisk().actions.get(`${package_name}/${action.name}`)
    .then(result => {
      const existing_annotations = _.groupBy(_.get(result, 'annotations', []), 'key');
      const existing_md5sum = _.get(existing_annotations, 'md5sum[0].value', 'n/a');

      winston.info(`Existing md5 checksum of ${package_name}/${action.name}: ${existing_md5sum}`)

      return {
        action: result,
        update: !_.isEqual(existing_md5sum, action.md5sum)
      }
    })
    .catch(error => {
      return {
        update: true
      };
    });
}

/**
 * Deletes remaining actions not provided in the action list.
 * 
 * @param {object} action         Must include 'name' and 'md5sum'
 * @param {string} package_name   The name of the package
 */
const openwhisk$delete_actions = (actions, package_name) => {
  winston.info(`Fetching all actions of package ${package_name}`)

  const ow = openwhisk();

  const delete_actions = (actions) => {
    const action = _.head(actions);

    if (action) {
      return ow.actions.delete(`${package_name}/${action}`)
        .then(result => {
          winston.info(`Deleted ${package_name}/${action} ...`)
          return delete_actions(_.tail(actions))
        })
        .then(result => _.concat([action], result));
    } else {
      return Promise.resolve();
    }
  }

  return ow.actions.list().then(existing_actions => {
    return _
      .chain(existing_actions)
      .filter(action => action.namespace.indexOf(`/${package_name}`) > -1)
      .map('name')
      .filter(name => {
        return _.indexOf(actions, name) < 0
      })
      .value()
  }).then(actions => {
    return delete_actions(actions);
  }).then(result => {
    winston.info(`Done cleaning actions in package ${package_name}.`);
  });
}

/**
 * Uploads an action ZIP file to openwhisk and attaches action.md5sum to the annotations.
 * 
 * @param {object} action        The action description, including 'name' and 'md5sum'.
 * @param {string} package_name  The name of the openwhisk package.
 * @param {string} archive_path  The archive path of a ZIP file.
 */
const openwhisk$upload_action = (action = {}, package_name, archive_path) => {
  if (action.update) {
    winston.info(`Uploading '${archive_path}' to action '${package_name}/${action.name}' ...`)
    const ow = openwhisk();
    const action_file = fs.readFileSync(archive_path);

    return ow.actions.create({
      name: `${package_name}/${action.name}`,
      overwrite: true,
      action: action_file
    }).then(action_result => {
      winston.info('Done uploading.');
      winston.info(`Updating package information for packge '${package_name}/${action.name}' ...`);

      const options = _.assign({}, action);
      const annotations = _.concat(_.get(action_result, 'annotations', []), _.get(options, 'annotations', []));
      
      _.set(options, 'annotations', _.concat(annotations, [{ key: 'md5sum', value: action.md5sum }]));

      return ow.actions.update({
        name: `${package_name}/${action.name}`,
        overwrite: true,
        action: _.omit(options, 'name')
      }).then(result => {
        winston.info('Done updating.');
        return action;
      });
    })
  } else {
    return Promise.resolve(action);
  }
}

exports.default = {
  create_zip_archive,
  create_md5sum,
  initialize_openwhisk_configuration,
  npm_install,
  openwhisk$create_package,
  openwhisk$delete_actions,
  openwhisk$check_existing_action,
  openwhisk$upload_action
}