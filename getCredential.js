// File: pages/api/fetchHtmlToJson.js

import axios from "axios";

export default async function getCredentials(url, authToken, uuid) {
  if (!url) {
    console.error("No URL provided");
    return;
  }

  try {
    const response = await axios.post(
      url,
      {
        job_uuid: uuid,
      },
      {
        headers: {
          "Content-Type": "application/json", // Example header for JSON request
          Authorization: `Bearer ${authToken}`, // Example Authorization header
        },
      }
    );

    return response?.data; // Parse the response as JSON if applicable
  } catch (error) {
    console.error("Error fetching or parsing HTML:", error);
  }
}
