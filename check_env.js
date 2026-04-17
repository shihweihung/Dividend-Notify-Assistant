async function checkEnv() {
  try {
    const response = await fetch("http://localhost:3000/api/debug-env");
    const data = await response.json();
    console.log("Environment Debug Info:", JSON.stringify(data, null, 2));
  } catch (error) {
    console.error("Failed to fetch debug info:", error);
  }
}

checkEnv();
