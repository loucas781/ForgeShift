'use strict'
const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const dataDir = path.join(__dirname, '../../data')
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'forgeshift.db')

const db = new Database(dbPath)

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

module.exports = db
