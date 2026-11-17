import {normalizeCliMetadata} from './generic-cli.mjs'
export function readOpenCodeMetadata(input={}){return {...normalizeCliMetadata({...input,provider:input.provider||'opencode',cli:input.cli||'opencode'}),source:'opencode'}}
