
async function testApi() {
  const symbol = process.argv[2] || "2605";
  console.log(`Testing API for ${symbol}...`);
  try {
    const response = await fetch(`http://localhost:3000/api/dividend/${symbol}`);
    console.log("Status:", response.status);
    const data = await response.json();
    if (response.ok) {
      console.log("Success! Data received:", JSON.stringify(data).substring(0, 100) + "...");
    } else {
      console.error("API Error:", data);
    }
  } catch (error) {
    console.error("Fetch failed:", error);
  }
}

testApi();
