#!/usr/bin/env node

const { mix } = require('../lib/index.js');

const tool = 'add-in';
const args = process.argv.slice(2);

mix(tool, args)
    .then(() => {
        // Successful completion naturally exits with code 0
    })
    .catch(err => {
        console.error(err.message);
        if (process.env.VERBOSE === '1' || args.includes('-v') || args.includes('--verbose')) {
            console.error(err.stack);
        }
        process.exit(1);
    });
