import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { nip5aManifest } from '@napplet/vite-plugin';
export default defineConfig({build:{modulePreload:{polyfill:false}},plugins: [viteSingleFile(), nip5aManifest({nappletType: 'pokemon-poc', requires: ['identity', 'outbox']})]});
