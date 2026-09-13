// Use an installed browser when requested; all upstream conformance checks remain unchanged.
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),entry=new URL('./dist/cli.js','file://'+require.resolve('@napplet/conformance-cli/package.json')).pathname;
if(process.env.PLAYWRIGHT_CHANNEL) {
  const {chromium}=createRequire(entry)('playwright'),launch=chromium.launch.bind(chromium);
  chromium.launch=options=>launch({...options,channel:process.env.PLAYWRIGHT_CHANNEL});
}
process.argv=[process.execPath,entry,'./dist'];
await import(entry);
