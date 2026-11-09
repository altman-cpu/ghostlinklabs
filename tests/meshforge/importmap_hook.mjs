/* Maps the bare "three" specifier to the local stub when running under Node. */
export async function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: new URL('./three_stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
