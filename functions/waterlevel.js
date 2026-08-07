export async function onRequest() {
  const url = "https://waterlevel.ie/geojson/latest/";
  const response = await fetch(url);
  const text = await response.text();

  return new Response(text, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Content-Type": "application/json"
    }
  });
}

