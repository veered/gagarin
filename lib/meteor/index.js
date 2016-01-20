
var createMeteorProcessManager = require('./meteorProcessManager');
var createDDPClientManager     = require('../ddp/ddpClientManager');
var Build                      = require('./build');
var MongoDatabase              = require('../mongo/database');
var meteorMethods              = require('./methods');
var Promise                    = require('es6-promise').Promise;
var Closure                    = require('../tools/closure');
var generic                    = require('../tools/generic');
var tools                      = require('../tools');
var url                        = require('url');
var path                       = require('path');
var fs                         = require('fs');
var _                          = require('lodash');

module.exports = function createMeteor (options) {
  "use strict";
  options = options || {};
  if (typeof options === 'string') {
    options = { pathToApp: options };
  }
  var pathToApp = options.pathToApp || path.resolve('.');
  var skipBuild = !!options.skipBuild;
  var verbose   = !!options.verbose;

  var remoteServer    = options.remoteServer ? url.parse(options.remoteServer) : null;
  var mongoUrlPromise = null;
  var databasePromise = null;

  var getMeteorProcess = createMeteorProcessManager(options);
  var getDDPClient     = createDDPClientManager();
  var closure          = null;

  var getConfig = function () { return Promise.reject(new Error('meteor must be initialized before use')) };

  if (typeof options.mongoUrl === 'string') {
    mongoUrlPromise = Promise.resolve(options.mongoUrl);

  } else if (options.mongoUrl && options.mongoUrl.then) {
    mongoUrlPromise = options.mongoUrl;

  } else if (options.mongoUrl) {
    throw new Error('mongoUrl must be a string or a promise returning a string');
  }

  var helpers = options.helpers || {};

  var myPrototype = Object.create(helpers);

  myPrototype.init = function (config) {
    getConfig = _.memoize(function () { // the version check will only be executed once
      return Promise.resolve(config);
    });
    return this;
  }

  myPrototype.start = function (onStart) {
    return this.then(function () {
      console.warn('\n  meteor.start is now deprecated; use meteor.startup instead\n');
    })
    .startup(onStart);
  }

  myPrototype.startup = function (onStart) {
    var self = this;

    return self.promise(function (resolve) { // wait on startup first
      Meteor.startup(resolve);

    }).then(function () {

      if (typeof onStart === 'function') {
        return onStart.length ? self.noWait().promise(onStart) : self.noWait().execute(onStart);

      } else if (onStart !== undefined) {
        throw new Error('onStart has to be a function');
      }

    });
  }

  myPrototype.stop = function () {

    // TODO: do not start if we haven't done it yet

    return this.__custom__(function (operand, done) {

      operand.ddpClient.close();

      if (!operand.process) { // e.g. if using remote server
        return done();
      }

      operand.process.kill(function (err) {
        if (err) {
          done(err);
        } else if (databasePromise && options.mongoUrl) {
          databasePromise.then(function (db) {
            db.cleanUp(done);
          }).catch(done);
        } else {
          done();
        }
      });
    });
  }

  // TODO: think if this can be implemented outside the manager

  //myPrototype.restart = function (delay) {
  //  var self = this;
  //  return self.then(function () {
  //    uniqueCode = Math.random();
  //    return this.__custom__(function (operand, done) {
  //      done();
  //    });
  //  });
  //}

  var methods = [ // copy/pasted meteor process methods
    'restart'
  ];

  Object.keys(meteorMethods).forEach(function (name) {
    myPrototype[name] = meteorMethods[name];
  });

  var MeteorGeneric = generic(methods, myPrototype, {
    action: function (operand, name, args, done) {
      if (!operand.process) {
        done(new Error('operand.process is undefined'));
      } else if (!operand.process[name]) {
        done(new Error('operand.process does not implement method: ' + name));
      } else {
        args.push(done);
        operand.process[name].apply(operand.process, args);
      }
    },
  });

  // create an object inheriting from MeteorGeneric

  var meteor = Object.create(new MeteorGeneric(), {
    methods: { value: [].concat(Object.keys(myPrototype), Object.keys(helpers), MeteorGeneric.prototype.methods) }
  });

  MeteorGeneric.call(meteor, getOperand);

  meteor.getDDPSetup = getDDPSetup;

  // add closure mixins, i.e. "useClosure" and "closure" methods

  Closure.mixin(meteor);
  closure = meteor.closure.bind(meteor);

  // helper functions producing usefull promises

  // note that the build is not executed right away! it's deferred until we call build.start()
  var build = new Build({ pathToApp: pathToApp, skipBuild: skipBuild, verbose: verbose });

  function getPathToMain () {
    return getConfig().then(function () {
      return build.start();
    });
  }

  function getMongoUrl () {

    if (mongoUrlPromise) { // e.g. when we are using remote a remote server
      return mongoUrlPromise;
    }

    if (remoteServer) {
      // this error should not be seen by users ... if it happened it would be a sign
      // that something wrong is going on
      return Promise.reject(new Error('when using a remote server getMongoUrl is not allowed'));
    }

    databasePromise = new MongoDatabase({ pathToApp: pathToApp, mongoUrl: options.mongoUrl });
    mongoUrlPromise = databasePromise.getMongoUrlPromise();

    return mongoUrlPromise;
  }

  var ensureVersionIsFine = _.memoize(function () {
    return checkIfVersionsMatch(pathToApp);
  });

  function getMeteor () {

    // TODO: optimize this function because
    //       it's going to be called every time
    //       a new promise is created

    if (remoteServer) {
      return Promise.resolve(null);
    }

    return Promise.all([

      getPathToMain(),

      getPathToMain().then(function () {
        // don't try to get the node path if the build fails
        return tools.getNodePath(pathToApp);
      }),

      getPathToMain().then(function () {
        // don't try to spawn mongo if the build fails
        return getMongoUrl();
      }),

    ]).then(function (results) {

      return ensureVersionIsFine().then(function () {

        return getMeteorProcess({

          pathToMain : results[0],
          pathToNode : results[1],
          mongoUrl   : results[2],
        });

      });

    });
  }

  function getOperand () {

    //NOTE: we can potentially use the "getConfig()" promise to provide some async configuration

    return Promise.all([

      getDDPSetup(), getMeteor(), getConfig()

    ]).then(function (results) {

      return getDDPClient(results[0]).then(function (ddpClient) {
        return { ddpClient: ddpClient, process: results[1], closure: closure };
      });

    });
  }

  function getDDPSetup () {

    if (remoteServer) {
      return Promise.resolve({
        hostname : remoteServer.hostname,
        port     : remoteServer.port || 443,
      });
    }

    return getMeteor().then(function (process) {
      return {
        port: process.env.PORT,
        code: process.pid,
      };
    });

  }

  return meteor;

}

function checkIfVersionsMatch(pathToApp) {

  var version = require('../../package.json').version;

  return new Promise(function (resolve, reject) {
    var pathToVersions = path.join(pathToApp, '.meteor', 'versions');

    fs.readFile(pathToVersions, { encoding: 'utf-8' }, function (err, content) {
      if (err) { // in older Meteor releases this file did not exist
        // TODO: verify release
        return resolve();
      }
      var versionMatch = content.match(/anti:gagarin@(.*)/);
      if (!versionMatch) { // looks like gagarin is not even instaled
        reject(new Error('Please add anti:gagarin to your app before running tests.'));
      } else if (versionMatch[1] !== version) { // versions of gagarin are not compatible
        reject(new Error(
          'Versions of node package (' + version +
          ') and meteor package (' + versionMatch[1] +
          ') are not compatible; please update.'
        ));
      }
      resolve(); // everything's fine
    });
  });

}
