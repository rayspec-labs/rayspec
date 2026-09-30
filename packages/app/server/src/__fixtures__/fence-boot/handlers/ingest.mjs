// An upload: the request body is stored as one object under the upload id.
export const ingest = async (init) => {
  const bytes = new Uint8Array(await init.request.arrayBuffer());
  await init.blob.put(`uploads/${init.params.upload_id}`, bytes);
  return new Response(JSON.stringify({ stored: bytes.length }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
