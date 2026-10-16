export async function getHttpRequest<JsonData = any>(url: string, headers: Record<string, string> = {}, userAgent?: string): Promise<JsonData> {
  // Build the request headers
  const token = process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'];
  if (!token) {
    throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_TOKEN env variable');
  }
  headers['Authorization'] = `Bearer ${token}`;

  // Set the User-Agent header, including the orchestration ID if available
  userAgent ||= 'actions/http-client';
  const orchId = process.env['ACTIONS_ORCHESTRATION_ID'];
  if (orchId) {
    // Sanitize the orchestration ID to ensure it contains only valid characters
    // Valid characters: 0-9, a-z, _, -, .
    const sanitizedId = orchId.replace(/[^a-z0-9_.-]/gi, '_');
    userAgent += ` actions_orchestration_id/${sanitizedId}`;
  }
  headers['User-Agent'] = userAgent;

  const response = await fetch(url, { method: 'GET', headers });
  if (!response.ok) {
    throw new Error(`Request ${url} error! Status: ${response.status}`);
  }
  return await response.json();
}

export async function getIDToken(audience?: string): Promise<string> {
  let idTokenUrl = process.env['ACTIONS_ID_TOKEN_REQUEST_URL'];
  if (!idTokenUrl) {
    throw new Error('Unable to get ACTIONS_ID_TOKEN_REQUEST_URL env variable');
  }
  if (audience && audience.length > 0) {
    idTokenUrl = `${idTokenUrl}&audience=${encodeURIComponent(audience)}`;
  }

  try {
    const id_token = await getHttpRequest<{ value: string }>(idTokenUrl);
    if (!id_token || !id_token.value) {
      throw new Error('Response json body do not have ID Token field');
    }
    return id_token.value;
  } catch (error) {
    throw new Error(`Failed to get ID Token. \nError: ${error}`);
  }
}
