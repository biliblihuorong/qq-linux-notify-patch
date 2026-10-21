// Notification failure must never block the original QQ startup.
try { require('./qq-notifier-main.js'); } catch (_) {}
module.exports = require('./application.asar/app_launcher/index.js');
