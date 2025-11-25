#!/usr/bin/env node

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawn } = require('child_process');
const os = require('os');

// Configuration
const DEFAULT_GIST_LINKS_ID = '9b32b03f207a191099137429051ebde8';
const USER_AGENT = 'add-in node tool';
const VERSION = '1.0.0';

// Gist ID length constants
const GIST_ID_LENGTH_SHORT = 20;
const GIST_ID_LENGTH_LONG = 32;
const GIST_ID_LENGTH_FULL = 40;

// Global state
let gistLinksId = process.env.MIX_SOURCE || DEFAULT_GIST_LINKS_ID;
let gitHubToken = process.env.GITHUB_TOKEN || '';
let verbose = false;
let silent = false;
let forceApproval = false;
let preserve = false;
let outDir = null;
let projectName = null;
let replaceTokens = [];
let ignoreSslErrors = false;

// Cache for gist links and files
const gistLinksCache = new Map();
const gistFilesCache = new Map();

// Host files to search for when resolving $HOST
const HOST_FILES = [
    'appsettings.json',
    'Web.config',
    'App.config',
    'Startup.cs',
    'Program.cs',
    '*.csproj',
];

/**
 * Make an HTTP/HTTPS request
 */
function httpRequest(url, options = {}) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const protocol = urlObj.protocol === 'https:' ? https : http;
        
        const reqOptions = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: options.method || 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json',
                ...options.headers
            },
            rejectUnauthorized: !ignoreSslErrors
        };

        if (gitHubToken) {
            reqOptions.headers['Authorization'] = `token ${gitHubToken}`;
        }

        const req = protocol.request(reqOptions, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ data, headers: res.headers, statusCode: res.statusCode });
                } else {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

/**
 * Get JSON from GitHub API
 */
async function getJson(route) {
    const url = route.startsWith('http') ? route : `https://api.github.com${route}`;
    if (verbose) console.log(`API: ${url}`);
    const response = await httpRequest(url);
    return JSON.parse(response.data);
}

/**
 * Convert camelCase to kebab-case
 */
function camelToKebab(str) {
    return (str || '').replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Split PascalCase into words
 */
function splitPascalCase(input) {
    if (!input) return input;
    let result = '';
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === char.toUpperCase() && char !== char.toLowerCase()) {
            if (i > 1 && input[i-1] !== input[i-1].toUpperCase() ||
                (i + 1 < input.length && input[i+1] !== input[i+1].toUpperCase())) {
                result += ' ';
            }
        }
        result += char;
    }
    return result.trim();
}

/**
 * Sanitize project name
 */
function sanitizeProjectName(name) {
    if (!name) return null;
    const sepChars = [' ', '-', '+', '_'];
    if (!sepChars.some(c => name.includes(c))) return name;
    
    const words = name.split(new RegExp(`[${sepChars.map(c => '\\' + c).join('')}]`));
    return words
        .filter(w => w)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join('');
}

/**
 * Replace MyApp placeholders with project name
 */
function replaceMyApp(input, projName) {
    if (!input || !projName) return input;
    
    const condensed = projName.replace(/_/g, '');
    const kebab = camelToKebab(condensed);
    const split = splitPascalCase(condensed);
    
    let result = input
        .replace(/My_App/g, projName)
        .replace(/MyApp/g, condensed)
        .replace(/My App/g, split)
        .replace(/my-app/g, kebab)
        .replace(/myapp/g, condensed.toLowerCase())
        .replace(/my_app/g, projName.toLowerCase());

    // Remove carriage returns on non-Windows
    if (process.platform !== 'win32') {
        result = result.replace(/\r/g, '');
    }

    // Apply custom replace tokens
    for (const [term, replacement] of replaceTokens) {
        result = result.split(term).join(replacement);
    }

    return result;
}

/**
 * Convert path separators to OS-specific format
 */
function osPaths(filePath) {
    if (process.platform === 'win32') {
        return filePath.replace(/\//g, '\\');
    }
    return filePath.replace(/\\/g, '/');
}

/**
 * Parse gist link from markdown line
 */
function parseGistLink(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('- [')) return null;

    // Parse: - [name](url) {modifiers} `tags` description
    const nameMatch = trimmed.match(/- \[([^\]]+)\]\(([^)]+)\)/);
    if (!nameMatch) return null;

    const name = nameMatch[1];
    const url = nameMatch[2];
    let remaining = trimmed.substring(nameMatch[0].length).trim();

    // Parse modifiers like {to:"./"}
    const modifiers = {};
    if (remaining.startsWith('{')) {
        const endBrace = remaining.indexOf('}');
        if (endBrace > 0) {
            const modStr = remaining.substring(1, endBrace);
            // Parse simple key:value or key:"value" pairs
            const modMatches = modStr.matchAll(/(\w+):(?:"([^"]+)"|'([^']+)'|([^\s,}]+))/g);
            for (const match of modMatches) {
                modifiers[match[1]] = match[2] || match[3] || match[4];
            }
            remaining = remaining.substring(endBrace + 1).trim();
        }
    }

    // Parse tags like `tag1,tag2`
    let tags = null;
    if (remaining.startsWith('`')) {
        const endTick = remaining.indexOf('`', 1);
        if (endTick > 0) {
            const tagStr = remaining.substring(1, endTick);
            tags = tagStr.split(',').map(t => t.trim()).filter(t => t);
            remaining = remaining.substring(endTick + 1).trim();
        }
    }

    // Rest is description
    const description = remaining;

    // Extract user from URL
    let user = url.startsWith('https://') 
        ? url.substring('https://'.length).split('/')[1] 
        : '';
    
    // Normalize user
    if (user === 'gistlyn' || user === 'mythz') {
        user = 'ServiceStack';
    }

    // Parse gist ID or repo info
    let gistId = null;
    let repo = null;

    if (url.startsWith('https://gist.github.com')) {
        gistId = url.split('/').pop();
    } else if (url.startsWith('https://github.com/')) {
        const pathInfo = url.substring('https://github.com/'.length);
        const parts = pathInfo.split('/');
        user = parts[0];
        repo = parts[1]?.split('/')[0];
    }

    return {
        name,
        url,
        user,
        to: modifiers.to || null,
        description,
        tags,
        gistId,
        repo,
        modifiers
    };
}

/**
 * Parse gist links from markdown content
 */
function parseGistLinks(md) {
    const links = [];
    if (!md) return links;

    for (const line of md.split('\n')) {
        const link = parseGistLink(line);
        if (link) links.push(link);
    }
    return links;
}

/**
 * Get gist files from GitHub
 */
async function getGistFiles(gistIdOrUrl) {
    const cacheKey = gistIdOrUrl;
    if (gistFilesCache.has(cacheKey)) {
        return { files: gistFilesCache.get(cacheKey), url: gistIdOrUrl };
    }

    let gistUrl;
    let gistId;

    if (!gistIdOrUrl.includes('://')) {
        // Plain gist ID
        gistId = gistIdOrUrl;
        gistUrl = `https://gist.github.com/${gistIdOrUrl}`;
    } else if (gistIdOrUrl.startsWith('https://gist.github.com/')) {
        gistUrl = gistIdOrUrl;
        const parts = gistIdOrUrl.substring('https://gist.github.com/'.length).split('/');
        if (parts.length === 3) {
            gistId = parts.slice(1).join('/');
        } else if (parts.length === 2) {
            const firstPartLen = parts[0].length;
            gistId = (firstPartLen === GIST_ID_LENGTH_SHORT || firstPartLen === GIST_ID_LENGTH_LONG)
                ? parts.join('/')
                : parts.slice(1).join('/');
        } else if (parts.length === 1) {
            gistId = parts[0];
        } else {
            throw new Error(`Invalid Gist URL '${gistIdOrUrl}'`);
        }
    } else {
        // Custom URL
        gistUrl = gistIdOrUrl;
        const json = await getJson(gistIdOrUrl);
        const files = fromJsonGist(json, gistIdOrUrl);
        gistFilesCache.set(cacheKey, files);
        return { files, url: gistUrl };
    }

    const json = await getJson(`/gists/${gistId}`);
    const files = fromJsonGist(json, gistId);
    gistFilesCache.set(cacheKey, files);
    return { files, url: gistUrl };
}

/**
 * Parse gist files from JSON response
 */
function fromJsonGist(response, gistRef) {
    const files = response.files;
    if (!files) {
        throw new Error(`Invalid gist response returned for '${gistRef}'`);
    }

    const result = {};
    for (const [filename, meta] of Object.entries(files)) {
        let content = meta.content;
        const size = meta.size;
        
        // Handle truncated files
        if ((!content || content.length < size) && meta.truncated) {
            // Would need to download from raw_url - for now just use what we have
            if (verbose) console.log(`Note: File '${filename}' is truncated`);
        }
        
        result[filename] = content || '';
    }
    return result;
}

/**
 * Get gist links from registry
 */
async function getGistApplyLinks() {
    const cacheKey = `${gistLinksId}:mix.md`;
    if (gistLinksCache.has(cacheKey)) {
        return gistLinksCache.get(cacheKey);
    }

    const { files } = await getGistFiles(gistLinksId);
    const mixMd = files['mix.md'];
    
    if (!mixMd) {
        throw new Error(`Could not find 'mix.md' file in gist '${gistLinksId}'`);
    }

    const links = parseGistLinks(mixMd);
    gistLinksCache.set(cacheKey, links);
    return links;
}

/**
 * Check if string is a valid gist ID
 */
/**
 * Check if string is a valid gist ID
 * Gist IDs are typically 20 or 32 characters long (hex strings)
 */
function isGistId(str) {
    if (str.includes('-') || str.includes('.') || str.includes(':')) return false;
    if (str.includes('/')) {
        const parts = str.split('/');
        const firstPart = parts[0];
        // If first part is 40 chars (full SHA), not a simple gist ID
        if (firstPart.length === GIST_ID_LENGTH_FULL) return false;
        return firstPart.length === GIST_ID_LENGTH_SHORT || firstPart.length === GIST_ID_LENGTH_LONG;
    }
    return str.length === GIST_ID_LENGTH_SHORT || str.length === GIST_ID_LENGTH_LONG;
}

/**
 * Find gist link by name
 */
function findGistLink(links, alias) {
    const sanitized = alias.replace(/-/g, '').toLowerCase();
    return links.find(l => l.name.replace(/-/g, '').toLowerCase() === sanitized);
}

/**
 * Resolve base path for output
 */
function resolveBasePath(to, exSuffix = '') {
    if (to === '.' || !to) {
        return process.cwd();
    }

    if (to.includes('..')) {
        throw new Error(`Invalid location '${to}'${exSuffix}`);
    }

    if (to.startsWith('/')) {
        if (process.platform === 'win32') {
            throw new Error(`Cannot write to '${to}' on Windows${exSuffix}`);
        }
        return to;
    }

    if (to.includes(':\\')) {
        if (process.platform !== 'win32') {
            throw new Error(`Cannot write to '${to}'${exSuffix}`);
        }
        return to;
    }

    if (to.startsWith('$')) {
        if (to.startsWith('$HOST')) {
            for (const hostFile of HOST_FILES) {
                const files = findFiles(process.cwd(), hostFile);
                if (files.length > 0) {
                    return path.dirname(files[0]);
                }
            }
            throw new Error(`Couldn't find host project location containing any of ${HOST_FILES.join(', ')}${exSuffix}`);
        }

        if (to.startsWith('$HOME')) {
            return to.replace('$HOME', os.homedir());
        }
    } else {
        if (to.endsWith('/')) {
            const dirName = to.slice(0, -1);
            const dirs = findDirectories(process.cwd(), dirName);
            if (dirs.length === 0) {
                throw new Error(`Unable to find Directory named '${dirName}'${exSuffix}`);
            }
            return dirs[0];
        } else {
            const files = findFiles(process.cwd(), to);
            if (files.length === 0) {
                throw new Error(`Unable to find File named '${to}'${exSuffix}`);
            }
            return path.dirname(files[0]);
        }
    }

    throw new Error(`Unknown location '${to}'${exSuffix}`);
}

/**
 * Find files matching pattern recursively
 */
function findFiles(dir, pattern, maxDepth = 10) {
    const results = [];
    if (maxDepth <= 0) return results;

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            
            const fullPath = path.join(dir, entry.name);
            
            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && entry.name !== 'bin' && entry.name !== 'obj') {
                    results.push(...findFiles(fullPath, pattern, maxDepth - 1));
                }
            } else if (entry.isFile()) {
                if (pattern.includes('*')) {
                    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                    if (regex.test(entry.name)) {
                        results.push(fullPath);
                    }
                } else if (entry.name === pattern) {
                    results.push(fullPath);
                }
            }
        }
    } catch (e) {
        // Ignore permission errors
    }
    return results;
}

/**
 * Find directories matching name recursively
 */
function findDirectories(dir, name, maxDepth = 10) {
    const results = [];
    if (maxDepth <= 0) return results;

    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            
            if (entry.isDirectory()) {
                const fullPath = path.join(dir, entry.name);
                if (entry.name === name) {
                    results.push(fullPath);
                }
                if (entry.name !== 'node_modules' && entry.name !== 'bin' && entry.name !== 'obj') {
                    results.push(...findDirectories(fullPath, name, maxDepth - 1));
                }
            }
        }
    } catch (e) {
        // Ignore permission errors
    }
    return results;
}

/**
 * Resolve file path for gist file
 */
function resolveFilePath(gistFilePath, basePath, projName, applyTo) {
    let fileName = replaceMyApp(osPaths(gistFilePath), projName);
    if (fileName.endsWith('?')) {
        fileName = fileName.slice(0, -1);
    }

    const resolvedFile = path.resolve(basePath, osPaths(fileName));

    // Handle $HOST gists that write to folders
    const writesToFolder = gistFilePath.includes('\\');
    if (applyTo === '$HOST' && writesToFolder && !fs.existsSync(path.dirname(resolvedFile))) {
        const currentBasePath = process.cwd();
        const tryPath = projName + '.' + gistFilePath;
        const resolvedPath = resolveFilePath(tryPath, currentBasePath, projName, '.');
        if (fs.existsSync(path.dirname(resolvedPath))) {
            if (verbose) console.log(`Using matching qualified path: ${resolvedPath}`);
            return resolvedPath;
        }
    }

    return resolvedFile;
}

/**
 * Print gist links
 */
function printGistLinks(tool, links, tag = null, usage = null) {
    console.log('');

    const tags = [...new Set(links.filter(l => l.tags).flatMap(l => l.tags))].sort();

    if (tag) {
        links = links.filter(l => l.tags && matchesTag(l, tag));
        const plural = tag.includes(',') ? 's' : '';
        console.log(`Results matching tag${plural} [${tag}]:`);
        console.log('');
    }

    const padName = Math.max(...links.map(l => l.name.length)) + 1;
    const padTo = Math.max(...links.map(l => (l.to || '').length)) + 1;
    const padBy = Math.max(...links.map(l => l.user.length)) + 1;
    const padDesc = Math.max(...links.map(l => l.description.length)) + 1;

    links.forEach((link, i) => {
        const toLabel = link.to ? ` to: ${link.to.padEnd(padTo, ' ')}` : '';
        const tagsStr = link.tags ? `[${link.tags.join(',')}]` : '';
        console.log(` ${String(i + 1).padStart(3, ' ')}. ${link.name.padEnd(padName, ' ')} ${link.description.padEnd(padDesc, ' ')}${toLabel} by @${link.user.padEnd(padBy, ' ')} ${tagsStr}`);
    });

    console.log('');

    if (usage) {
        console.log(usage);
        return;
    }

    console.log(`   Usage: ${tool} <name> <name> ...`);
    console.log('');
    console.log(`  Search: ${tool} [tag] Available tags: ${tags.join(', ')}`);
    console.log('');
    console.log(`Advanced: ${tool} ?`);
}

/**
 * Check if link matches tag(s)
 */
function matchesTag(link, tagName) {
    if (!link.tags) return false;
    const searchTags = tagName.split(',').map(t => t.trim().toLowerCase());
    return searchTags.length === 1
        ? link.tags.some(t => t.toLowerCase() === searchTags[0])
        : link.tags.some(t => searchTags.includes(t.toLowerCase()));
}

/**
 * Prompt user for yes/no
 */
function promptYesNo(message) {
    return new Promise((resolve) => {
        if (silent || forceApproval) {
            resolve(true);
            return;
        }

        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        console.log(message);
        console.log('Proceed? (n/Y):');

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.once('data', (data) => {
            process.stdin.setRawMode(false);
            rl.close();
            const key = data.toString().toLowerCase();
            resolve(key === '\r' || key === '\n' || key === 'y');
        });
    });
}

/**
 * Apply JSON patch to target file
 */
async function patchJsonFile(targetFile, patchFile) {
    if (!fs.existsSync(targetFile)) {
        fs.writeFileSync(targetFile, '{}');
    }

    const targetJson = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
    const patchJson = JSON.parse(fs.readFileSync(patchFile, 'utf8'));

    // Simple JSON patch implementation
    for (const op of patchJson) {
        const pathParts = op.path.split('/').filter(p => p);
        let target = targetJson;

        // Navigate to parent
        for (let i = 0; i < pathParts.length - 1; i++) {
            const key = pathParts[i];
            if (!(key in target)) {
                target[key] = {};
            }
            target = target[key];
        }

        const lastKey = pathParts[pathParts.length - 1];

        switch (op.op) {
            case 'add':
            case 'replace':
                target[lastKey] = op.value;
                break;
            case 'remove':
                delete target[lastKey];
                break;
        }
    }

    fs.writeFileSync(targetFile, JSON.stringify(targetJson, null, 2));
}

/**
 * Write gist files to disk
 */
async function writeGistFile(gistIdOrUrl, gistAlias, to, projName) {
    projName = sanitizeProjectName(projName);

    const { files, url: gistLinkUrl } = await getGistFiles(gistIdOrUrl);

    const resolvedFiles = [];
    let initFile = null;

    for (const [fileName, content] of Object.entries(files)) {
        if (fileName.includes('..')) {
            throw new Error(`Invalid file name '${fileName}' from '${gistLinkUrl}'`);
        }

        const alias = gistAlias ? `'${gistAlias}' ` : '';
        const exSuffix = ` required by ${alias}${gistLinkUrl}`;
        const basePath = resolveBasePath(to, exSuffix);

        if (fileName === '_init') {
            initFile = { name: fileName, content };
            continue;
        }

        const resolvedFile = resolveFilePath(fileName, basePath, projName, to);
        const noOverride = preserve || fileName.endsWith('?');
        if (noOverride && fs.existsSync(resolvedFile)) {
            if (verbose) console.log(`Skipping existing optional file: ${resolvedFile}`);
            continue;
        }

        resolvedFiles.push({
            path: resolvedFile,
            content: replaceMyApp(content, projName),
            originalName: fileName
        });
    }

    // Display files and prompt for approval
    const label = gistAlias && !gistAlias.includes('://') ? `'${gistAlias}' ` : '';

    if (!silent) {
        let message = `\nWrite files from ${label}${decodeURIComponent(gistLinkUrl)} to:\n\n`;
        for (const file of resolvedFiles) {
            message += `  ${file.path}\n`;
        }

        if (!forceApproval) {
            const approved = await promptYesNo(message);
            if (!approved) {
                throw new Error('Operation cancelled by user.');
            }
        } else {
            console.log(message.replace('Write files from', 'Writing files from'));
        }
    }

    // Execute _init file commands
    if (initFile) {
        const hostDir = resolveBasePath(to, ` required by ${gistLinkUrl}`);
        const lines = initFile.content.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#')) continue;

            const cmd = trimmed;
            
            // Only allow specific commands
            const allowedPrefixes = ['npm ', 'yarn ', 'pnpm ', 'nuget ', 'dotnet ', 'flutter ', 'dart ', 'kamal '];
            const isAllowed = allowedPrefixes.some(p => cmd.startsWith(p));
            
            if (!isAllowed) {
                if (verbose) console.log(`Command '${cmd}' not supported`);
                continue;
            }

            // Additional restrictions
            if (cmd.startsWith('nuget') && !['nuget add', 'nuget restore', 'nuget update'].some(c => cmd.startsWith(c))) {
                if (verbose) console.log(`Command '${cmd}' not allowed`);
                continue;
            }
            if (cmd.startsWith('dotnet') && !['dotnet add ', 'dotnet restore'].some(c => cmd.startsWith(c)) && cmd !== 'dotnet restore') {
                if (verbose) console.log(`Command '${cmd}' not allowed`);
                continue;
            }
            if (cmd.startsWith('flutter') && !cmd.startsWith('flutter create ')) {
                if (verbose) console.log(`Command '${cmd}' not allowed`);
                continue;
            }
            if (cmd.startsWith('dart') && !['dart pub add', 'dart pub get'].some(c => cmd.startsWith(c))) {
                if (verbose) console.log(`Command '${cmd}' not allowed`);
                continue;
            }
            if (cmd.startsWith('kamal') && !cmd.startsWith('kamal init')) {
                if (verbose) console.log(`Command '${cmd}' not allowed`);
                continue;
            }

            // Check for illegal characters
            if (/["'&;$@|>]/.test(cmd)) {
                console.log(`Command contains illegal characters, ignoring: '${cmd}'`);
                continue;
            }

            // Execute command using spawn with argument array for better security
            console.log(cmd);
            const cmdParts = cmd.split(' ');
            const executable = cmdParts[0];
            const rawArgs = cmdParts.slice(1);
            const cmdArgs = rawArgs.map(arg => replaceMyApp(arg, projName.replace(/\./g, '_')));
            
            try {
                const result = require('child_process').spawnSync(executable, cmdArgs, { 
                    cwd: hostDir, 
                    stdio: 'inherit',
                    shell: false
                });
                if (result.error) {
                    throw result.error;
                }
            } catch (e) {
                console.log(`Failed to execute: ${cmd}`);
                if (verbose) console.log(e.message);
            }
        }
    }

    // Write files
    for (const file of resolvedFiles) {
        if (file.originalName === '_init') continue;
        
        if (verbose) console.log(`Writing ${file.path}...`);
        
        const dir = path.dirname(file.path);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        let filePath = file.path;
        let content = file.content;

        // Handle base64 encoded files
        if (filePath.endsWith('|base64')) {
            filePath = filePath.slice(0, -7);
            const buffer = Buffer.from(content, 'base64');
            fs.writeFileSync(filePath, buffer);
        } else {
            fs.writeFileSync(filePath, content);
        }

        // Handle JSON patches
        if (filePath.endsWith('.json.patch')) {
            const patchTarget = filePath.slice(0, -6); // Remove .patch
            if (fs.existsSync(patchTarget)) {
                console.log(`Patching ${patchTarget}...`);
                await patchJsonFile(patchTarget, filePath);
                fs.unlinkSync(filePath);
            }
        }
    }
}

/**
 * Apply gists
 */
async function applyGists(tool, gistAliases, projName = null) {
    projName = projName || path.basename(process.cwd());

    const links = await getGistApplyLinks();

    // Resolve numeric aliases
    const resolvedAliases = gistAliases.map(alias => {
        const num = parseInt(alias, 10);
        if (!isNaN(num) && num > 0 && num <= links.length) {
            return links[num - 1].name;
        }
        return alias;
    });

    for (const gistAlias of resolvedAliases) {
        // Check if it's a gist ID
        if (isGistId(gistAlias)) {
            await writeGistFile(`https://gist.github.com/${gistAlias}`, gistAlias, outDir || '.', projName);
            forceApproval = true;
            continue;
        }

        // Check if it's a URL
        if (gistAlias.startsWith('https://') || gistAlias.startsWith('http://')) {
            await writeGistFile(gistAlias, gistAlias, outDir || '.', projName);
            forceApproval = true;
            continue;
        }

        // Find in registry
        const gistLink = findGistLink(links, gistAlias);
        if (!gistLink) {
            console.log(`No match found for '${gistAlias}', available gists:`);
            printGistLinks(tool, links);
            return false;
        }

        await writeGistFile(gistLink.gistId || gistLink.url, gistAlias, outDir || gistLink.to || '.', projName);
        forceApproval = true;
    }

    return true;
}

/**
 * Delete gist files
 */
async function deleteGists(tool, gistAliases, projName) {
    projName = projName || path.basename(process.cwd());
    const links = await getGistApplyLinks();

    // Resolve numeric aliases
    const resolvedAliases = gistAliases.map(alias => {
        const num = parseInt(alias, 10);
        if (!isNaN(num) && num > 0 && num <= links.length) {
            return links[num - 1].name;
        }
        return alias;
    });

    const allResolvedFiles = [];
    let output = '';

    for (const gistAlias of resolvedAliases) {
        let to = '.';
        let gistLinkUrl;
        let gistFiles;

        if (isGistId(gistAlias)) {
            const result = await getGistFiles(gistAlias);
            gistFiles = result.files;
            gistLinkUrl = result.url;
        } else if (gistAlias.startsWith('https://') || gistAlias.startsWith('http://')) {
            const result = await getGistFiles(gistAlias);
            gistFiles = result.files;
            gistLinkUrl = result.url;
        } else {
            const gistLink = findGistLink(links, gistAlias);
            if (!gistLink) {
                console.log(`No match found for '${gistAlias}', available gists:`);
                printGistLinks(tool, links);
                return false;
            }

            gistLinkUrl = gistLink.url;
            to = gistLink.to || '.';
            const result = await getGistFiles(gistLink.gistId || gistLink.url);
            gistFiles = result.files;
        }

        const alias = gistAlias ? `'${gistAlias}' ` : '';
        const exSuffix = ` required by ${alias}${gistLinkUrl}`;
        const basePath = resolveBasePath(to, exSuffix);

        const resolvedFiles = [];
        for (const gistFile of Object.keys(gistFiles)) {
            const resolvedFile = resolveFilePath(gistFile, basePath, projName, to);
            if (!fs.existsSync(resolvedFile)) {
                if (verbose) console.log(`Skipping deleting non-existent file: ${resolvedFile}`);
                continue;
            }
            resolvedFiles.push(resolvedFile);
            allResolvedFiles.push(resolvedFile);
        }

        if (resolvedFiles.length > 0) {
            const label = gistAlias ? `'${gistAlias}' ` : '';
            const plural = resolvedFiles.length !== 1 ? 's' : '';
            output += `\nDelete ${resolvedFiles.length} file${plural} from ${label}${gistLinkUrl}:\n\n`;
            for (const file of resolvedFiles) {
                output += `${file}\n`;
            }
        }
    }

    if (allResolvedFiles.length === 0) {
        console.log(`Did not find any existing files from '${gistAliases.join(',')}' to delete`);
        return false;
    }

    if (!silent) {
        if (!forceApproval) {
            const approved = await promptYesNo(output);
            if (!approved) {
                throw new Error('Operation cancelled by user.');
            }
        } else {
            console.log(output);
        }

        console.log('');
        console.log(`Deleting ${allResolvedFiles.length} files...`);
    }

    const folders = new Set();
    for (const file of allResolvedFiles) {
        if (verbose) console.log(`RM: ${file}`);
        try {
            fs.unlinkSync(file);
            folders.add(path.dirname(file));
        } catch (e) {
            if (verbose) console.log(`ERROR: ${e.message}`);
        }
    }

    // Delete empty folders
    const sortedFolders = [...folders].sort((a, b) => b.length - a.length);
    for (const folder of sortedFolders) {
        try {
            const entries = fs.readdirSync(folder);
            if (entries.length === 0) {
                if (verbose) console.log(`RMDIR: ${folder}`);
                fs.rmSync(folder, { recursive: false });
            }
        } catch (e) {
            // Ignore errors
        }
    }

    if (!silent) {
        console.log('Done.');
    }

    return true;
}

/**
 * Print help
 */
function printHelp(tool) {
    console.log(`Version: ${VERSION}`);
    console.log('');
    console.log('View all published gists:');
    console.log(`   ${tool}`);
    console.log('');
    console.log('Simple Usage:');
    console.log(`   ${tool} <name> <name> ...`);
    console.log('');
    console.log('Apply add-in using numbered list index instead:');
    console.log(`   ${tool} 1 3 5 ...`);
    console.log('');
    console.log('Apply add-in file contents from gist URL:');
    console.log(`   ${tool} <gist-url>`);
    console.log('');
    console.log('Delete previous add-ins:');
    console.log(`   ${tool} -delete <name> <name> ...`);
    console.log('');
    console.log('Use custom project name instead of current folder name (replaces MyApp):');
    console.log(`   ${tool} -name ProjectName <name> <name> ...`);
    console.log('');
    console.log('Replace additional tokens before applying add-in:');
    console.log(`   ${tool} -replace term=with <name> <name> ...`);
    console.log('');
    console.log('Multi replace with escaped string example:');
    console.log(`   ${tool} -replace term=with -replace "This Phrase"="With This" <name> <name> ...`);
    console.log('');
    console.log('Only display available gists with a specific tag:');
    console.log(`  ${tool} [tag]`);
    console.log(`  ${tool} [tag1,tag2]`);
}

/**
 * Parse command line arguments
 */
function parseArgs(args) {
    const result = {
        help: false,
        deleteMode: false,
        gistAliases: []
    };

    const helpArgs = ['/help', '--help', '-help', '?'];
    const verboseArgs = ['/v', '-v', '/verbose', '-verbose', '--verbose'];
    const sourceArgs = ['/s', '-s', '/source', '-source', '--source'];
    const forceArgs = ['/f', '-f', '/force', '-force', '--force'];
    const yesArgs = ['/y', '-y', '/yes', '-yes', '--yes'];
    const preserveArgs = ['/p', '-p', '/preserve', '-preserve', '--preserve'];
    const ignoreSslArgs = ['/ignore-ssl-errors', '--ignore-ssl-errors'];
    const deleteArgs = ['/delete', '-delete', '--delete'];
    const outArgs = ['/out', '-out', '--out'];
    const nameArgs = ['/name', '-name', '--name'];
    const replaceArgs = ['/replace', '-replace', '--replace'];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (helpArgs.includes(arg)) {
            result.help = true;
            continue;
        }
        if (verboseArgs.includes(arg)) {
            verbose = true;
            continue;
        }
        if (sourceArgs.includes(arg)) {
            gistLinksId = args[++i];
            continue;
        }
        if (forceArgs.includes(arg) || yesArgs.includes(arg)) {
            forceApproval = true;
            silent = true;
            continue;
        }
        if (preserveArgs.includes(arg)) {
            preserve = true;
            continue;
        }
        if (ignoreSslArgs.includes(arg)) {
            ignoreSslErrors = true;
            continue;
        }
        if (deleteArgs.includes(arg)) {
            result.deleteMode = true;
            continue;
        }
        if (outArgs.includes(arg)) {
            outDir = args[++i];
            if (!outDir.endsWith('/')) outDir += '/';
            continue;
        }
        if (nameArgs.includes(arg)) {
            projectName = args[++i];
            if (!projectName) throw new Error('Missing -name value');
            continue;
        }
        if (replaceArgs.includes(arg)) {
            const replacePair = args[++i];
            if (!replacePair) throw new Error('Missing -replace value, e.g -replace term=with');
            
            const eqPos = replacePair.indexOf('=');
            if (eqPos === -1) throw new Error('Invalid -replace usage, e.g: -replace term=with');
            
            const term = replacePair.substring(0, eqPos);
            const replacement = replacePair.substring(eqPos + 1);
            replaceTokens.push([term, replacement]);
            continue;
        }
        if (arg.startsWith('-')) {
            throw new Error(`Unknown switch: ${arg}`);
        }

        result.gistAliases.push(arg);
    }

    return result;
}

/**
 * Main entry point
 */
async function mix(tool, args) {
    const parsed = parseArgs(args);

    if (parsed.help) {
        printHelp(tool);
        return false;
    }

    if (parsed.gistAliases.length === 0) {
        // List all gists
        const links = await getGistApplyLinks();
        printGistLinks(tool, links);
        return false;
    }

    const firstArg = parsed.gistAliases[0];

    // Check for tag search
    if (firstArg.startsWith('#')) {
        const links = await getGistApplyLinks();
        printGistLinks(tool, links, firstArg.substring(1));
        return false;
    }
    if (firstArg.startsWith('[') && firstArg.endsWith(']')) {
        const links = await getGistApplyLinks();
        printGistLinks(tool, links, firstArg.substring(1, firstArg.length - 1));
        return false;
    }

    // Handle + separator
    let gistAliases = parsed.gistAliases;
    if (gistAliases.length === 1 && gistAliases[0].includes('+')) {
        gistAliases = gistAliases[0].split('+');
    }

    if (!parsed.deleteMode) {
        return applyGists(tool, gistAliases, projectName);
    } else {
        return deleteGists(tool, gistAliases, projectName);
    }
}

module.exports = {
    mix,
    getGistApplyLinks,
    applyGists,
    deleteGists,
    printGistLinks,
    parseGistLinks,
    VERSION
};
