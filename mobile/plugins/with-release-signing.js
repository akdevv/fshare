// Signs release APKs with your own key when FSHARE_KEYSTORE is set (CI release job); otherwise
// they stay debug-signed, which is fine for installing on your own phones.
// Env: FSHARE_KEYSTORE (path), FSHARE_KEYSTORE_PASSWORD, FSHARE_KEY_ALIAS, FSHARE_KEY_PASSWORD.
const { withAppBuildGradle } = require('expo/config-plugins');

module.exports = (config) =>
  withAppBuildGradle(config, (c) => {
    let g = c.modResults.contents;
    if (g.includes('FSHARE_KEYSTORE')) return c;
    g = g.replace(
      /signingConfigs \{\n/,
      `signingConfigs {
        release {
            if (System.getenv('FSHARE_KEYSTORE')) {
                storeFile file(System.getenv('FSHARE_KEYSTORE'))
                storePassword System.getenv('FSHARE_KEYSTORE_PASSWORD')
                keyAlias System.getenv('FSHARE_KEY_ALIAS')
                keyPassword System.getenv('FSHARE_KEY_PASSWORD')
            }
        }
`,
    );
    g = g.replace(
      /(release \{\n(?:\s*\/\/.*\n)*\s*)signingConfig signingConfigs\.debug/,
      `$1signingConfig System.getenv('FSHARE_KEYSTORE') ? signingConfigs.release : signingConfigs.debug`,
    );
    c.modResults.contents = g;
    return c;
  });
