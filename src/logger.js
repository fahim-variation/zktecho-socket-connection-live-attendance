/**
 * PNG image decoder… nope — just logging helpers. 😄
 */
function ts() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

function log(scope, msg) {
  console.log(`${colors.gray}[${ts()}]${colors.reset} ${colors.cyan}[${scope}]${colors.reset} ${msg}`);
}

function ok(scope, msg) {
  console.log(`${colors.gray}[${ts()}]${colors.reset} ${colors.green}[${scope}]${colors.reset} ✅ ${msg}`);
}

function warn(scope, msg) {
  console.log(`${colors.gray}[${ts()}]${colors.reset} ${colors.yellow}[${scope}]${colors.reset} ⚠️  ${msg}`);
}

function err(scope, msg) {
  console.log(`${colors.gray}[${ts()}]${colors.reset} ${colors.red}[${scope}]${colors.reset} ❌ ${msg}`);
}

function data(scope, msg) {
  console.log(`${colors.gray}[${ts()}]${colors.reset} ${colors.magenta}[${scope}]${colors.reset} 📦 ${msg}`);
}

module.exports = { log, ok, warn, err, data };
