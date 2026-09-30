// A READ route that still appends to the tenant event bus: what the fence's event-bus gate refuses
// once the runtime has drained, although the HTTP method is not a mutation.
export const emitOnRead = async (init) => {
  await init.emit('fence.read', { at: 'read' });
  return { emitted: true };
};
