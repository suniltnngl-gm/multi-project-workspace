import {normalizeCliMetadata} from './generic-cli.mjs'
export function readAgyMetadata(input={}){return {...normalizeCliMetadata({...input,provider:input.provider||'agy',cli:input.cli||'agy'}),source:'agy'}}
