const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');
const os = require('os');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

const dev = process.argv.includes('--dev');
const live = process.argv.includes('--live') || !dev;
const watch = process.argv.includes('--watch');

// Watch defaults to dev mode so it never silently overwrites the live plugin.
const isDev = watch ? (dev || !live) : dev;

const titanPluginsDir = process.env.TITAN_PLUGINS_DIR ||
    `C:/Users/${os.userInfo().username}/.titanclient/plugins`;
const outFile = isDev
    ? `${titanPluginsDir}/stark-mercher-dev.js`
    : `${titanPluginsDir}/stark-mercher.js`;

const config = {
    entryPoints: ['stark-mercher.ts'],
    bundle: true,
    outfile: outFile,
    target: 'es2020',
    format: 'iife',
    platform: 'neutral',
    minify: false,
    sourcemap: false,
    logLevel: 'info',
    define: {
        __DEV__: isDev ? 'true' : 'false',
        __LIVE__: isDev ? 'false' : 'true',
        __VERSION__: JSON.stringify(packageJson.version),
    },
};

if (watch) {
    esbuild.context(config).then(ctx => {
        console.log(`[Stark Mercher Build] Watching (${isDev ? 'dev' : 'live'}) -> ${outFile}`);
        return ctx.watch();
    }).catch(err => {
        console.error(err);
        process.exit(1);
    });
} else {
    console.log(`[Stark Mercher Build] Building (${isDev ? 'dev' : 'live'}) -> ${outFile}`);
    esbuild.build(config).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
