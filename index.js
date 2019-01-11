// Copyright 2016 Yahoo Inc.
// Licensed under the terms of the MIT license. Please see LICENSE file in the project root for terms.

var Promise = require('bluebird');
var messageHash = require('incoming-message-hash');
var assert = require('assert');
var mkdirp = require('mkdirp');
var path = require('path');
var buffer = require('./lib/buffer');
var proxy = require('./lib/proxy');
var record = require('./lib/record');
var curl = require('./lib/curl');
var debug = require('debug')('yakbak:server');
var fs = require('fs');

function isValidStatusCode(code) {
  return code >= 200 && code < 400
}

/**
 * Returns a new yakbak proxy middleware.
 * @param {String} host The hostname to proxy to
 * @param {Object} opts
 * @param {String} opts.dirname The tapes directory
 * @param {Boolean} opts.noRecord if true, requests will return a 404 error if the tape doesn't exist
 * @param {Boolean} opts.recordOnlySuccess if true, only successful requests will be recorded
 * @returns {Function}
 */

module.exports = function (host, opts) {
  assert(opts.dirname, 'You must provide opts.dirname');

  return function (req, res) {
    mkdirp.sync(opts.dirname);

    debug('req', req.url);

    return buffer(req).then(function (body) {
      var file = path.join(opts.dirname, tapename(req, body));

      return Promise.try(function () {
        var fileName = require.resolve(file);
        var err;

        // If tape was deleted, then throw module not found error
        // so that it can be re-recorded instead of failing on
        // require
        if (!fs.existsSync(fileName)) {
          err = new Error('File does not exist');

          err.code = 'MODULE_NOT_FOUND';
          throw err;
        }

        return fileName;
      }).catch(ModuleNotFoundError, function (/* err */) {

        if (opts.noRecord) {
          throw new RecordingDisabledError('Recording Disabled');
        } else {
          return proxy(req, body, host).then(function (pres) {
            if (opts.recordOnlySuccess === true) {
                if (isValidStatusCode(pres.statusCode)) {
                   return record(pres.req, pres, file);
                } else {
                  throw new InvalidStatusCodeError('Only Successful responses will be recorded', pres);
                }
            } else {
              return record(pres.req, pres, file);
            }
          });
        }

      });
    }).then(function (file) {
      return require(file);
    }).then(function (tape) {
      return tape(req, res);
    }).catch(RecordingDisabledError, function (err) {
      debug(err.message);
      debug(curl.request(req));
      res.statusCode = err.status;
      res.end(err.message);
    }).catch(InvalidStatusCodeError, function (err) {
      debug(err.message);
      debug(curl.request(req));
      err.res.pipe(res, { end: true });
    });

  };

  /**
   * Returns the tape name for `req`.
   * @param {http.IncomingMessage} req
   * @param {Array.<Buffer>} body
   * @returns {String}
   */

  function tapename(req, body) {
    var hash = opts.hash || messageHash.sync;

    return hash(req, Buffer.concat(body)) + '.js';
  }

};

/**
 * Bluebird error predicate for matching module not found errors.
 * @param {Error} err
 * @returns {Boolean}
 */

function ModuleNotFoundError(err) {
  return err.code === 'MODULE_NOT_FOUND';
}

/**
 * Error class that is thrown when an unmatched request
 * is encountered in noRecord mode or when a request failed in recordOnlySuccess mode
 * @constructor
 */

function RecordingDisabledError(message) {
  this.message = message;
  this.status = 404;
}

function InvalidStatusCodeError(message, res) {
  this.message = message;
  this.status = 404;
  this.res = res;
}

RecordingDisabledError.prototype = Object.create(Error.prototype);
