const _ = require('lodash')
const fs = require('fs')
const glob = require('glob')
const minimatch = require('minimatch')
const path = require('path')

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
 * Reads a file by line into an array
 * 
 * @param {string} path 
 * @param {object} defaultValue 
 */
const read_list = (path, defaultValue = []) => {
  if (fs.existsSync(path) && fs.lstatSync(path).isFile()) {
    const content = fs.readFileSync(path, "utf-8");
    return content.split(/\r?\n/);
  } else {
    return defaultValue;
  }
}

/**
 * Lists files of a directory.
 * 
 * @param {string}          directory     The name of the directory to list
 * @param {array[string]}   ignorelist    Items to ignore
 * @param {string}          filetype      The type of the files, one of: "*" - all, "d" - directories, "f" - files
 * @param {boolean}         recursive     If true, the directory is listed recursively
 */
const read_filelist = (directory, ignorelist = [], filetype = '*', recursive = true) => {
  const pattern = recursive ? '**' : '*';
  const files = glob.sync(pattern, { cwd: directory });
  
  return _
    .chain(files)
    .filter(file => _.findIndex(ignorelist, entry => minimatch(file, entry)) < 0)
    .filter(file => {
      if (filetype === '*') {
        return true;
      } else {
        const file_path = path.resolve(directory, file);
        const stats = fs.statSync(file_path);

        if (filetype === "d" && stats.isDirectory()) {
          return true;
        } else if (filetype === "f" && stats.isFile()) {
          return true;
        } else {
          return false;
        }
      }
    })
    .value();
}

exports.default = {
  read_json,
  read_list,
  read_filelist
}