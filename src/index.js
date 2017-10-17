import Ajv from 'ajv'
import fs from 'fs'
import faker from 'faker'
import merge from 'lodash.merge'
import logger from 'debug'
import path from 'path'
import YAML from 'js-yaml'
import Promise from 'bluebird'
import proxyquire from 'proxyquire'

const debug = logger('syncano-test')

const socketFolder = process.cwd()
const socketScriptsFolder = path.join(socketFolder, 'src')
const compiledScriptsFolder = path.join(socketFolder, '.src')
const socketDefinition = YAML.load(fs.readFileSync('./socket.yml', 'utf8'))

const generateMeta = (endpointName, metaUpdate) => {
  const socketName = socketDefinition.name

  const apiHost = process.env.SYNCANO_HOST
  const token = process.env.SYNCANO_AUTH_KEY
  const instance = process.env.SYNCANO_INSTANCE_NAME || process.env.SYNCANO_PROJECT_INSTANCE

  let meta = {
    socket: socketName,
    api_host: apiHost,
    token,
    instance,
    debug: process.env.DEBUG || false,
    executor: `${socketName}/${endpointName}`,
    executed_by: 'socket_endpoint',
    request: {
      REQUEST_METHOD: 'POST',
      PATH_INFO: '/v2/instances/withered-voice-2245/endpoints/sockets/norwegian-postcode/search/',
      HTTP_USER_AGENT: faker.internet.userAgent(),
      HTTP_CONNECTION: 'close',
      REMOTE_ADDR: faker.internet.ip(),
      HTTP_HOST: apiHost,
      HTTP_UPGRADE_INSECURE_REQUESTS: '1',
      HTTP_ACCEPT: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      HTTP_ACCEPT_LANGUAGE: 'en,en-US;q=0.8,pl;q=0.6',
      HTTP_ACCEPT_ENCODING: 'gzip, deflate, br'
    },
    metadata: socketDefinition.endpoints[endpointName]
  }
  if (metaUpdate) {
    meta = merge(meta, metaUpdate)
  }
  return meta
}

async function verifyResponse (endpoint, responseType, response) {
  const endpointDefinition = socketDefinition.endpoints[endpoint]
  const endpointDefParameters = socketDefinition.endpoints[endpoint].response[responseType].parameters
  const ajv = new Ajv()

  const desiredExitCode = endpointDefinition.response[responseType].exit_code || 200
  const desiredMimetype = endpointDefinition.mimetype || 'application/json'

  if (response.code !== desiredExitCode) {
    throw new Error(`Wrong exit code! Desired code is ${desiredExitCode}, got: ${response.code}`)
  }

  if (response.mimetype !== desiredMimetype) {
    throw new Error(`Wrong mimetype! Desired mimetype is ${desiredMimetype}, got: ${response.mimetype}`)
  }

  const schema = {
    type: 'object',
    properties: endpointDefParameters,
    additionalProperties: false
  }

  const validate = ajv.compile(schema)
  const valid = validate(response.data)

  if (!valid) {
    const detailsMsg = validate.errors.map(err => {
      return `     - ${err.message} (${JSON.stringify(err.params)})`
    }).join('\n')

    const error = new Error(`\n\n    Validation error:\n${detailsMsg}\n`)
    error.details = validate.errors
    throw error
  } else {
    return response
  }
}

function run (endpoint, ctx = {}, params = {}) {
  const {args = {'DEBUG': false}, config = {}, meta = {}} = ctx
  const mocks = params.mocks
  const socketMeta = generateMeta(endpoint, meta)

  debug(`Running endpoint: ${endpoint}`)
  return new Promise(function (resolve, reject) {
    let output = null

    const HttpResponse = function (code, data, mimetype) {
      let response = null
      if (mimetype === 'json/application') {
        response = {code, mimetype, data: JSON.parse(data)}
      } else {
        response = {code, data, mimetype}
      }
      response.is = (responseType) => verifyResponse(endpoint, responseType, response)
      return response
    }

    const setResponse = function (response) {
      const processedResponse = response
      if (response.mimetype === 'application/json') {
        processedResponse.data = JSON.parse(response.data)
      }
      resolve(processedResponse)
    }

    process.exitOrig = process.exit
    process.exit = () => {}

    module.filename = `${compiledScriptsFolder}/${endpoint}.js`

    try {
      let runFunc
      if (mocks) {
        runFunc = proxyquire(path.join(socketScriptsFolder, `${endpoint}.js`), mocks).default
      } else {
        runFunc = require(path.join(socketScriptsFolder, `${endpoint}.js`)).default
      }
      output = runFunc({args, config, meta: socketMeta, HttpResponse, setResponse})
    } catch (err) {
      reject(err)
    } finally {
      Promise.resolve(output).then(resolve)
    }
  })
}

export {
  run,
  generateMeta
}
