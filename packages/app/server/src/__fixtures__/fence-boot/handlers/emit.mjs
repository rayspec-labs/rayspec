// A READ route, declared read-only, that still appends to the tenant event bus: what the fence's
// event-bus gate refuses once the runtime has drained, although neither its method nor its declaration
// says it writes.
export const emitOnRead = async (init) => {
  await init.emit('fence.read', { at: 'read' });
  return { emitted: true };
};
