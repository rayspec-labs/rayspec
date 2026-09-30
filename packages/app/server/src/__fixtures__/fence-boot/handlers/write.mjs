// A GET route whose handler writes a store row: what the fence refuses as a mutation although its
// method is a read's, because its action is a handler that is not declared read-only.
export const writeOnRead = async (init) => {
  await init.db.insert('fence_notes', { body: 'written on read' });
  return { written: true };
};
