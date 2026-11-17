const ID_KEYS = ['execution_id','tool_run_id','agent_run_id','session_id']
const optionalId = (v,k) => v === undefined || v === null || (typeof v === 'string' && v.length > 0 && v.length <= 256) || (()=>{throw Error('execution_identity_invalid:'+k)})()
export function createExecutionContext(input={}) {
  if (!Number.isSafeInteger(input.task_id) || input.task_id < 1) throw Error('execution_task_id_invalid')
  if (typeof input.execution_id !== 'string' || !input.execution_id || input.execution_id.length > 256) throw Error('execution_id_required')
  const out={schema_version:'1.0.0',task_id:input.task_id,execution_id:input.execution_id,tool_run_id:input.tool_run_id??null,agent_run_id:input.agent_run_id??null,session_id:input.session_id??null,created_at:input.created_at||new Date().toISOString()}
  for(const k of ID_KEYS) optionalId(out[k],k)
  if(Number.isNaN(Date.parse(out.created_at))) throw Error('execution_timestamp_invalid')
  return Object.freeze(out)
}
export function validateExecutionContext(v) { const c=createExecutionContext(v); if(c.schema_version!=='1.0.0') throw Error('execution_schema_version_invalid'); return true }
