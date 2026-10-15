/**
 * scripts/patch-wwebjs.js
 *
 * Hotfixes whatsapp-web.js internal bug where media messages fail with:
 * "Error: Data passed to getter must include an id property (it's how we memoize) but got undefined"
 *
 * Root Cause:
 * In whatsapp-web.js/src/util/Injected/Utils.js, mediaOptions spreads __x_id and/or undefined id
 * into the outgoing message object, clobbering message.id (which was newMsgKey).
 *
 * Fix:
 * 1. Drop __x_id and id from mediaOptions before constructing message.
 * 2. Drop message.__x_id and enforce message.id = newMsgKey after construction.
 * 3. Drop __x_id and id on mediaData in processMediaData before returning.
 */

const fs = require('fs');
const path = require('path');

function patchWWebJS() {
    const utilsPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-web.js', 'src', 'util', 'Injected', 'Utils.js');

    if (!fs.existsSync(utilsPath)) {
        console.log('ℹ️ [patch-wwebjs] whatsapp-web.js not found in node_modules, skipping.');
        return false;
    }

    let content = fs.readFileSync(utilsPath, 'utf8');

    let modified = false;

    // 1. Patch message object inside window.WWebJS.sendMessage
    if (!content.includes('/* PATCH_WWEBJS_MEDIA_ID_FIX */')) {
        const regex = /(\.\.\.extraOptions,[\r\n\s]*\};)([\r\n\s]*)(\/\/ Bot's won't reply if canonicalUrl is set)/;
        if (regex.test(content)) {
            content = content.replace(regex, `$1$2/* PATCH_WWEBJS_MEDIA_ID_FIX */\n        delete message.__x_id;\n        delete mediaOptions.__x_id;\n        message.id = newMsgKey;$2$3`);
            modified = true;
        } else {
            const fallbackRegex = /(\.\.\.extraOptions,[\r\n\s]*\};)/;
            if (fallbackRegex.test(content)) {
                content = content.replace(fallbackRegex, `$1\n        /* PATCH_WWEBJS_MEDIA_ID_FIX */\n        delete message.__x_id;\n        delete mediaOptions.__x_id;\n        message.id = newMsgKey;`);
                modified = true;
            }
        }
    }

    // 2. Patch processMediaData return
    if (!content.includes('/* PATCH_WWEBJS_PROCESS_MEDIA_FIX */')) {
        const mediaReturnRegex = /(mediaHandle:\s*sendToChannel\s*\?\s*mediaEntry\.handle\s*:\s*null,[\r\n\s]*\}\);[\r\n\s]*)(return mediaData;)/;
        if (mediaReturnRegex.test(content)) {
            content = content.replace(mediaReturnRegex, `$1/* PATCH_WWEBJS_PROCESS_MEDIA_FIX */\n        delete mediaData.__x_id;\n        delete mediaData.id;\n        $2`);
            modified = true;
        }
    }

    if (modified) {
        fs.writeFileSync(utilsPath, content, 'utf8');
        console.log('✅ [patch-wwebjs] Successfully applied media memoize hotfixes to whatsapp-web.js!');
        return true;
    }

    console.log('✅ [patch-wwebjs] whatsapp-web.js is up to date.');
    return true;
}

if (require.main === module) {
    patchWWebJS();
}

module.exports = patchWWebJS;
