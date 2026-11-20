function resolveRef(ref, rootSchema) {
  if (!ref || !ref.startsWith('#/')) {
    throw new Error(`Unsupported $ref: ${ref}`)
  }
  const parts = ref.slice(2).split('/')
  let current = rootSchema
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      throw new Error(`Unresolvable $ref: ${ref}`)
    }
    current = current[part]
  }
  return current
}

function matchesType(value, expectedType) {
  if (expectedType === 'null') return value === null
  if (expectedType === 'array') return Array.isArray(value)
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value)
  if (expectedType === 'integer') return Number.isInteger(value)
  return typeof value === expectedType
}

export function validateInventorySchema(value, schema, rootSchema = schema, path = '$') {
  const errors = []
  if (!schema || typeof schema !== 'object') return errors

  const effective = schema.$ref ? resolveRef(schema.$ref, rootSchema) : schema

  if ('const' in effective && value !== effective.const) {
    errors.push(`${path}: expected const ${JSON.stringify(effective.const)}, got ${JSON.stringify(value)}`)
    return errors
  }

  if (Array.isArray(effective.enum) && !effective.enum.includes(value)) {
    errors.push(`${path}: value ${JSON.stringify(value)} not in enum`)
    return errors
  }

  if (effective.type) {
    const allowed = Array.isArray(effective.type) ? effective.type : [effective.type]
    if (!allowed.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected type ${allowed.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`)
      return errors
    }
  }

  if (Array.isArray(value) && effective.items) {
    for (let i = 0; i < value.length; i += 1) {
      errors.push(...validateInventorySchema(value[i], effective.items, rootSchema, `${path}[${i}]`))
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if (Array.isArray(effective.required)) {
      for (const key of effective.required) {
        if (!(key in value)) {
          errors.push(`${path}: missing required property "${key}"`)
        }
      }
    }

    const props = effective.properties || {}
    for (const [key, propValue] of Object.entries(value)) {
      if (key in props) {
        errors.push(...validateInventorySchema(propValue, props[key], rootSchema, `${path}.${key}`))
      } else if (effective.additionalProperties === false) {
        errors.push(`${path}: unexpected property "${key}"`)
      } else if (effective.additionalProperties && typeof effective.additionalProperties === 'object') {
        errors.push(...validateInventorySchema(propValue, effective.additionalProperties, rootSchema, `${path}.${key}`))
      }
    }
  }

  return errors
}

export function assertInventorySchema(value, schema, label = 'inventory') {
  const errors = validateInventorySchema(value, schema, schema, '$')
  if (errors.length > 0) {
    throw new Error(`${label} failed schema validation:\n- ${errors.join('\n- ')}`)
  }
}
