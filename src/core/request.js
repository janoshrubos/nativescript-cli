import isDefined from '../utils/isDefined';
import isFunction from 'lodash/lang/isFunction';
import isString from 'lodash/lang/isString';
import HttpMethod from './enums/httpMethod';
import Rack from '../rack/rack';
import ResponseType from './enums/responseType';
import Query from './query';
import url from 'url';
import Client from './client';
import Auth from './auth';
import DataPolicy from './enums/dataPolicy';
import KinveyError from './errors/error';
import assign from 'lodash/object/assign';
import merge from 'lodash/object/merge';
import result from 'lodash/object/result';
const privateRequestSymbol = Symbol();

class PrivateRequest {
  constructor(method = HttpMethod.GET, path = '', query, body, options = {}) {
    options = assign({
      auth: Auth.none,
      client: Client.sharedInstance(),
      dataPolicy: DataPolicy.CloudFirst
    }, options);

    // Validate options
    if (!(options.client instanceof Client)) {
      throw new KinveyError('options.client must be of type Kinvey');
    }

    // Validate query
    if (query && !(query instanceof Query)) {
      throw new KinveyError('query argument must be an instance of Kinvey.Query');
    }

    // Set request info
    this.method = method;
    this.headers = {};
    this.protocol = options.client.apiProtocol;
    this.host = options.client.apiHost;
    this.path = path;
    this.query = query;
    this.flags = options.flags;
    this.body = body;
    this.responseType = ResponseType.Text;
    this.client = options.client;
    this.auth = options.auth;
    this.dataPolicy = options.dataPolicy;
    this.executing = false;

    // Add default headers
    const headers = {};
    headers.Accept = 'application/json';
    headers['Content-Type'] = 'application/json';
    headers['X-Kinvey-Api-Version'] = process.env.KINVEY_API_VERSION;
    this.addHeaders(headers);
  }

  get method() {
    return this._method;
  }

  set method(method) {
    if (!isString(method)) {
      throw new Error('Invalid Http Method. It must be a string.');
    }

    // Make the method uppercase
    method = method.toUpperCase();

    switch (method) {
    case HttpMethod.OPTIONS:
    case HttpMethod.GET:
    case HttpMethod.POST:
    case HttpMethod.PATCH:
    case HttpMethod.PUT:
    case HttpMethod.DELETE:
      this._method = method;
      break;
    default:
      throw new Error('Invalid Http Method. OPTIONS, GET, POST, PATCH, PUT, and DELETE are allowed.');
    }
  }

  get url() {
    return url.format({
      protocol: this.protocol,
      host: this.host,
      pathname: this.path,
      query: merge({}, this.flags, result(this.query, 'toJSON', {})),
      hash: this.hash
    });
  }

  get responseType() {
    return this._responseType;
  }

  set responseType(type) {
    type = type || ResponseType.DOMString;
    let responseType;

    switch (type) {
    case ResponseType.Blob:
      try {
        responseType = new global.Blob() && 'blob';
      } catch (e) {
        responseType = 'arraybuffer';
      }

      break;
    case ResponseType.Document:
      responseType = 'document';
      break;
    case ResponseType.JSON:
      responseType = 'json';
      break;
    default:
      responseType = '';
    }

    this._responseType = responseType;
  }

  getHeader(header) {
    const keys = Object.keys(this.headers);

    for (let i = 0, len = keys.length; i < len; i++) {
      const key = keys[i];

      if (key.toLowerCase() === header.toLowerCase()) {
        return this.headers[key];
      }
    }

    return undefined;
  }

  setHeader(header, value) {
    const headers = this.headers;
    headers[header.toLowerCase()] = value;
    this.headers = headers;
  }

  addHeaders(headers = {}) {
    const keys = Object.keys(headers);

    keys.forEach((header) => {
      const value = headers[header];
      this.setHeader(header, value);
    });
  }

  removeHeader(header) {
    delete this.headers[header.toLowerCase()];
  }

  execute() {
    if (this.executing) {
      return Promise.reject(new KinveyError('The request is already executing.'));
    }

    const dataPolicy = this.dataPolicy;
    const method = this.method;
    let promise;

    // Switch the executing flag
    this.executing = true;

    if (dataPolicy === DataPolicy.LocalOnly) {
      promise = this.executeLocal();
    } else if (dataPolicy === DataPolicy.LocalFirst) {
      promise = this.executeLocal().then((response) => {
        if (response && response.isSuccess()) {
          if (this.method !== HttpMethod.GET) {
            const privateRequest = new PrivateRequest(method, this.path, this.query, response.data, {
              client: this.client,
              dataPolicy: DataPolicy.CloudOnly
            });
            privateRequest.auth = this.auth;
            return privateRequest.execute().then(() => {
              return response;
            });
          }
        } else {
          if (this.method === HttpMethod.GET) {
            const privateRequest = new PrivateRequest(method, this.path, this.query, response.data, {
              client: this.client,
              dataPolicy: DataPolicy.CloudFirst
            });
            privateRequest.auth = this.auth;
            return privateRequest.execute();
          }
        }

        return response;
      });
    } else if (dataPolicy === DataPolicy.CloudOnly) {
      promise = this.executeCloud();
    } else if (dataPolicy === DataPolicy.CloudFirst) {
      promise = this.executeCloud().then((response) => {
        if (response && response.isSuccess()) {
          const privateRequest = new PrivateRequest(method, this.path, this.query, response.data, {
            client: this.client,
            dataPolicy: DataPolicy.LocalOnly
          });
          privateRequest.auth = this.auth;

          if (method === HttpMethod.GET) {
            privateRequest.method = HttpMethod.PUT;
          }

          return privateRequest.execute().then(() => {
            return response;
          });
        } else if (this.method === HttpMethod.GET) {
          const privateRequest = new PrivateRequest(method, this.path, this.query, response.data, {
            client: this.client,
            dataPolicy: DataPolicy.LocalOnly
          });
          privateRequest.auth = this.auth;
          return privateRequest.execute();
        }

        return response;
      });
    }

    return promise.then((response) => {
      // Save the response
      this.response = response;

      // Switch the executing flag
      this.executing = false;

      // Return the response
      return response;
    }).catch((err) => {
      // Switch the executing flag
      this.executing = false;

      // Throw the err to allow it to
      // be caught later in the promise chain
      throw err;
    });
  }

  executeLocal() {
    const rack = Rack.cacheRack;
    return rack.execute(this);
  }

  executeCloud() {
    const auth = this.auth;
    const rack = Rack.networkRack;
    let promise = Promise.resolve();

    return promise.then(() => {
      if (isDefined(auth)) {
        promise = isFunction(auth) ? auth(this.client) : Promise.resolve(auth);

        // Add auth info to headers
        return promise.then((authInfo) => {
          if (authInfo !== null) {
            // Format credentials
            let credentials = authInfo.credentials;
            if (isDefined(authInfo.username)) {
              credentials = new Buffer(`${authInfo.username}:${authInfo.password}`).toString('base64');
            }

            // Set the header
            this.setHeader('Authorization', `${authInfo.scheme} ${credentials}`);
          }
        });
      }
    }).then(() => {
      return rack.execute(this);
    });
  }

  cancel() {

  }

  toJSON() {
    // Create an object representing the request
    const json = {
      headers: this.headers,
      method: this.method,
      url: this.url,
      path: this.path,
      query: this.query ? this.query.toJSON() : null,
      flags: this.flags,
      body: this.body,
      responseType: this.responseType,
      dataPolicy: this.dataPolicy,
      client: this.client.toJSON()
    };

    // Return the json object
    return json;
  }
}

class Request {
  constructor(method = HttpMethod.GET, path = '', query, body, options = {}) {
    this[privateRequestSymbol] = new PrivateRequest(method, path, query, body, options);
  }

  get method() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.method;
  }

  set method(method) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.method = method;
  }

  get protocol() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.protocol;
  }

  set protocol(protocol) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.protocol = protocol;
  }

  get host() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.host;
  }

  set host(host) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.host = host;
  }

  get auth() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.auth;
  }

  set auth(auth) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.auth = auth;
  }

  get path() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.path;
  }

  set path(path) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.path = path;
  }

  get query() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.query;
  }

  set query(query) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.query = query;
  }

  get flags() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.flags;
  }

  set flags(flags) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.flags = flags;
  }

  get body() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.body;
  }

  set body(body) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.body = body;
  }

  get dataPolicy() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.dataPolicy;
  }

  set dataPolicy(dataPolicy) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.dataPolicy = dataPolicy;
  }

  get response() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.response;
  }

  get url() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.url;
  }

  get responseType() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.responseType;
  }

  set responseType(type) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.responseType = type;
  }

  getHeader(header) {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.getHeader(header);
  }

  setHeader(header, value) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.setHeader(header, value);
  }

  addHeaders(headers) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.addHeaders(headers);
  }

  removeHeader(header) {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.removeHeader(header);
  }

  execute() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.execute();
  }

  cancel() {
    const privateRequest = this[privateRequestSymbol];
    privateRequest.cancel();
  }

  toJSON() {
    const privateRequest = this[privateRequestSymbol];
    return privateRequest.toJSON();
  }
}

export default Request;
