const _ = require('lodash');
const app = require('commander');
const fs = require('fs');
const tasks = require('./tasks').default;
const path = require('path');
const Promise = require('bluebird');
const utils = require('./utils').default;
const winston = require('winston')

app
  .version("1.0.0")
  .option("-d, --dir <directory>", "The root directory of the actions to be deployed. Defaults to '.' (current directory)")
  .option("--ow-apihost <hostname>", "The OpenWhisk API hostname. Overrides ${__OW_API_HOST} and settings from ~/.wskprops.")
  .option("--ow-apikey <apikey>", "The OpenWhisk API key. Overrides ${__OW_API_KEY} and settings from ~/.wskprops.")
  .option("--ow-apitoken <apitoken>", "The OpenWhisk API authorization token. Overrides ${__OW_APIGW_KEY} and settings from ~/.wskprops.")
  .parse(process.argv);

// Set defaults
app.dir = app.dir || '.'

// read configuration
const config_file = path.resolve(app.dir, './openwhisk.actions.json');
const package_file = path.resolve('./package.json');

const package_json = utils.read_json(package_file, {});
const config_json = utils.read_json(config_file, _.get(package_json, 'openwhisk', {}));

app.action_excludes = _.get(config_json, 'action_excludes', ['_template']);
app.action_md5sum_excludes = _.get(config_json, 'action_md5sum_excludes', ["node_modules/**", "*test.js","test/**"]);

/**
 * Checks the given directory and creates the according package and actions of it.
 * 
 * @param {string} directory 
 */
const openwhisk_package_from_dir = (directory) => {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) {
    const default_packagename = path.basename(directory);
    const package_info_file = path.resolve(directory, './openwhisk.package.json');
    const package_info = _.assign({ name: default_packagename }, utils.read_json(package_info_file));

    return tasks.openwhisk$create_package(package_info);
  } else {
    return Promise.reject(new Error(`The directory ${directory} does not exist or is not a directory.`))
  }
}

/**
 * Get the directories which may contain actions.
 * 
 * @param {*} directory 
 */
const action_directories = (directory) => {
  return Promise.resolve(
    _.map(utils.read_filelist(directory, app.action_excludes, "d", false), subdir => path.resolve(directory, subdir)));
}

/**
 * Sequentially creates/ updates all actions.
 * 
 * @param {string} package_name 
 * @param {array[string]} directories 
 */
const create_actions = (package_name, directories = []) => {
  const action_directory = _.head(directories);

  if (action_directory) {
    const default_actionname = path.basename(action_directory);
    const action_info_file = path.resolve(action_directory, './openwhisk.action.json');
    const action_info = _.assign({ name: default_actionname }, utils.read_json(action_info_file));
    winston.info(`Processing action '${package_name}/${action_info.name}' ...`)

    return Promise.resolve(action_info)
      .then(action_info => tasks.npm_install(action_directory).then(() => action_info))
      .then(action_info => tasks.create_md5sum(action_directory, app.action_md5sum_excludes).then(md5sum => _.assign({}, action_info, { md5sum })))
      .then(action_info => tasks.openwhisk$check_existing_action(action_info, package_name).then(({ update }) => _.assign({}, action_info, { update })))
      .then(action_info => {
        if (action_info.update) {
          winston.info(`Action '${package_name}/${action_info.name}' does not exist or is not up to date.`)
          const action_zip_file = path.resolve(action_directory, `${action_info.name}.zip`)

          return Promise.resolve(action_info)
            .then(action_info => tasks.create_zip_archive(action_directory, action_zip_file, []).then(() => action_info))
            .then(action_info => tasks.openwhisk$upload_action(action_info, package_name, action_zip_file))
            .then(action_info => {
              fs.unlinkSync(action_zip_file);
              winston.info(`Deleted '${action_zip_file}'`);
              return action_info;
            });
        } else {
          winston.info(`Action '${package_name}/${action_info.name}' is up to date.`)
          return Promise.resolve(action_info);
        }
      })
      .then(action_info => {
        return create_actions(package_name, _.tail(directories))
          .then(actions => _.concat([ action_info ], actions))
      })
  } else {
    return Promise.resolve([]);
  }
}

Promise.resolve()
  .then(() => tasks.initialize_openwhisk_configuration(app))
  .then(() => openwhisk_package_from_dir(app.dir))
  .then(({ name }) => action_directories(app.dir).then(directories => ({ package_name: name, directories })))
  .then(({ package_name, directories }) => create_actions(package_name, directories).then(actions => ({ actions: _.map(actions, 'name'), package_name, directories })))
  .then(({ actions, package_name, directories }) => tasks.openwhisk$delete_actions(actions, package_name))
  .then(() => {
    winston.info('Done');
  });