# openwhisk-action-manager

This node app is a command line utility to manage the deployment of an [Apache OpenWhisk](https://openwhisk.apache.org/) package and its actions. Some of the features are listed below:

* Creates OpenWhisk packages on deployment if not present
* Creates OpenWhisk actions on deployment if not present
* Checks if an update of an action is required due to code changes
* Deletes old actions (e.g. after renaming an action)
* Before creation/ update of an action it:
  * Executes `npm install` for each action
  * Packages the action as ZIP archive
  * Uploads the action to OpenWhisk
* Like the [OpenWhisk CLI](https://github.com/apache/incubator-openwhisk-cli) openwhisk-action-manager reads its OpenWhisk configuration from `~/.wskprops`

**Note:** As of now openwhisk-action-manager only supports Node actions. Help is welcome to extend openwhist-action-manager :)

## How To use

To use openwhisk-action-manager, all actions of a package need to be placed in a separate directory. E.g.:

```
└ my-openwhisk-package
  ├ my-first-action
  │ ├ index.js
  │ └ package.json  
  ├ my-second-action
  │ ├ index.js
  │ ├ index.test.js
  │ └ package.json
  └ package.json
```

Install openwhisk-action-manager:

```bash
npm install --save-dev openwhisk-action-manager
```

Add a deploy script task to your root `package.json` (`my-openwhisk-package/package.json` in the example above):

```json
{
  "scripts": {
    "deploy": "openwhisk-action-manager"
  }
}
```

Finally you can run `npm run deploy` or `./node_modules/bin/openwhisk-action-manager` to deploy your actions to openwhisk at once. If you already uploaded an action  with openwhisk-action-manager and have no changes made to your action it will ot be updated.

## Configuration

### CLI arguments

```
Usage: openwhisk-action-manager [options]

Options:

  -V, --version             output the version number
  -d, --dir <directory>     The root directory of the actions to be deployed. Defaults to '.' (current directory)
  --ow-apihost <hostname>   The OpenWhisk API hostname. Overrides ${__OW_API_HOST} and settings from ~/.wskprops.
  --ow-apikey <apikey>      The OpenWhisk API key. Overrides ${__OW_API_KEY} and settings from ~/.wskprops.
  --ow-apitoken <apitoken>  The OpenWhisk API authorization token. Overrides ${__OW_APIGW_KEY} and settings from ~/.wskprops.
  -h, --help                output usage information
```

### Configuration files

Additionaly packages and actions can have JSON files for further configuration.

**Note:** By design all the values which can be configured via configuration files cannot be overriden by command line arguments to force the usage of files sitting in the version control system.

#### Package configuration

A package directory may include a file `openwhisk.package.json`. This file can define the package name (default is the name of the directory) and other parameters sent to the [OpenWhisk REST API](https://console.bluemix.net/apidocs/98-ibm-bluemix-openwhisk?&language=node#introduction) when the package is created.

Example:

```json
{
  "name": "any-package-name",
  "publish": true
}
```

#### Action configuration

An action directory may include a file `openwhisk.action.json`. This file can define the action name (default is the name of the directory) and other parameters sent to the [OpenWhisk REST API](https://console.bluemix.net/apidocs/98-ibm-bluemix-openwhisk?&language=node#introduction) when the package is created/ updated.

Example:

```json
{
  "name": "any-action-name",
  "parameters": [
    {
      "key": "foo",
      "value": "bar"
    }
  ]
}
```

#### Other common configuration

Additional configuration can be placed in the root `package.json`. E.g.:

```json
{
  "devDependencies": {
    "openwhisk-action-manager": "0.0.4"
  },
  "openwhisk": {
    "action_excludes": ["_template", "node_modules"],
    "action_md5sum_excludes": ["node_modules/**", "*test.js","test/**"],
    "action_zip_excludes": ["*test.js","test/**"]
  }
}
```

The following values can be configured within `package.json`:

* **action_excludes** - An array of patterns to exclude directories within your root directory when creating the actions. Default: `["_template"]`
* **action_md5sum_excludes** - An array of patterns to exclude files when calculating the md5sum of the action. The md5sum is used to detect changes within your action. Default: `["node_modules/**", "*test.js","test/**"]`
* **action_zip_excludes** - An array of patterns to exclude files when creating the action ZIP file. Default: `["*test.js","test/**"]`

The pattern matching is based on `minimatch`. See [documentation](https://github.com/isaacs/minimatch) for usage.