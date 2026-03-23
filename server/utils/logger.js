'use strict'
const env = process.env.NODE_ENV || 'development'

function ts() { return new Date().toISOString() }

function log(level, ...args) {
  const prefix = `[${ts()}] [${level.toUpperCase()}]`
  if (level === 'error') console.error(prefix, ...args)
  else console.log(prefix, ...args)
}

module.exports = {
  info:  (...args) => log('info', ...args),
  warn:  (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args),
  debug: (...args) => { if (env === 'development') log('debug', ...args) },
}
