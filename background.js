import * as tf from "@tensorflow/tfjs";
let socket = null;
let reconnectTimeout = null;
// const url = "wss://orchestrator.openledger.dev/ws/v1/orch";
const url = process.env.NEXT_PUBLIC_WS_URL;

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Buffer } from "buffer";
import SHA256 from "crypto-js/sha256";
import TurndownService from "turndown";
import getScrape from "./getScrape.js";
import getCredentials from "./getCredential.js";
import { headers } from "next/headers.js";
import { hashAuthorization } from "viem/experimental";

import {
  getBytes,
  hexlify,
  randomBytes,
  sha256,
  toUtf8Bytes,
  toUtf8String,
  ethers,
} from "ethers";

chrome.runtime.onInstalled.addListener(() => {
  console.log("Extension Installed");
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error(error));

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (!tab.url) return;
  // Enables the side panel on google.com

  await chrome.sidePanel.setOptions({
    tabId,
    path: "index.html",
    enabled: true,
  });
});

chrome.alarms.create("keepAlive", {
  periodInMinutes: 0.25, // Periodic check to prevent deactivation
});

function keepAlive() {
  chrome.storage.local.set({ keepAlive: Date.now() });
}

setInterval(keepAlive, 20000);

// connectWebSocket(url);

function connectWebSocket(url, authToken) {
  let intervalId;
  if (socket && socket.readyState === WebSocket.OPEN) {
    console.log("WebSocket is already open.");
    chrome.runtime.sendMessage({
      type: "ALREADY_CONNECTED",
    });
    return;
  }
  // Function to handle WebSocket connection

  function createWebSocket(type) {
    const wsUrl = `${url}?authToken=${authToken}`;
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      chrome.runtime.sendMessage({
        type: "WEBSOCKET_CONNECTED",
        message: type,
      });
      clearTimeout(reconnectTimeout);
      clearInterval(intervalId);
      sendIntervalInfo();
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message?.MsgType !== "JOB") {
        chrome.runtime.sendMessage({
          type: "WEBSOCKET_RESPONSE",
          data: event.data,
        });
      }
      loadJobData(event);
    };

    socket.onerror = (error) => {
      console.error("WebSocket encountered an error:", error);
    };

    socket.onclose = (event) => {
      reconnectWebSocket();
      clearInterval(intervalId);
    };
  }

  async function reconnectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      return;
    }

    let auth_token = await getLocalStorage("auth_token");

    if (auth_token) {
      reconnectTimeout = setTimeout(() => {
        createWebSocket("reconnect");
      }, 5000);
    } // Retry after 5 seconds
  }

  async function sendHeartbeat() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.warn("Cannot send heartbeat, WebSocket is not open.");
      return;
    }

    try {
      const extensionId = chrome?.runtime.id;
      const encPrivateKey = await getLocalStorage("privateKey");
      const privateKey = await decryptData(encPrivateKey);
      const wallet = new ethers.Wallet(privateKey);

      const memoryInfo = await getAvailableMemoryPercentage();
      const storageInfo = await getAvailableStoragePercentage();
      const models = await tf.io.listModels();

      const heartbeatMessage = {
        message: {
          Worker: {
            Identity: base64Encode(wallet?.address),
            ownerAddress: wallet?.address,
            type: "LWEXT",
            Host: `chrome-extension://${extensionId}`,
          },
          Capacity: {
            AvailableMemory: memoryInfo?.availableMemoryPercentage,
            AvailableStorage: storageInfo,
            AvailableGPU: "",
            AvailableModels: Object.keys(models),
          },
        },
        msgType: "HEARTBEAT",
        workerType: "LWEXT",
        workerID: base64Encode(wallet?.address),
      };

      socket.send(JSON.stringify(heartbeatMessage));
    } catch (error) {
      console.error("Error sending heartbeat:", error);
    }
  }

  // Start the WebSocket connection
  createWebSocket();

  // Periodically send heartbeat messages
  function sendIntervalInfo() {
    intervalId = setInterval(async () => {
      if (socket?.readyState === WebSocket.OPEN) {
        let auth_token = await getLocalStorage("auth_token");
        auth_token && sendHeartbeat();
      } else {
        console.warn("Skipping heartbeat, WebSocket not open.");
      }
    }, 30000);
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  // The callback for runtime.onMessage must return falsy if we're not sending a response
  (async () => {
    if (message.type === "open_side_panel") {
      // This will open a tab-specific side panel only on the current tab.
      await chrome.sidePanel.open({ tabId: message?.tabId });
      await chrome.sidePanel.setOptions({
        tabId: message?.tabId,
        path: "index.html",
        enabled: true,
      });
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "send_websocket_message" && socket) {
    socket.send(message.data);
    sendResponse({ status: "Message sent, waiting for response" });

    return true;
  }
  if (message.type === "connect_socket") {
    connectWebSocket(url, message?.data?.authToken);

    // socket.onopen = () => {
    sendResponse({ type: "Connected" });
    // };
    return true;
  }

  if (message.type === "close_socket") {
    socket?.close();
    clearLocalStorage();
    sendResponse({ type: "Closed" });
    return true;
  }
  // return true;
});

const base64Encode = (input) => {
  return btoa(input);
};

const loadJobData = async (event) => {
  const privateKey = await getLocalStorage("privateKey");
  const decPrivateKey = await decryptData(privateKey);
  const wallet = new ethers.Wallet(decPrivateKey);
  const message = JSON.parse(event.data);

  if (message?.MsgType == "JOB") {
    socket?.send(
      JSON.stringify({
        workerID: base64Encode(wallet?.address),
        msgType: "JOB_ASSIGNED",
        workerType: "LWEXT",
        message: {
          Status: true,
          Ref: message?.UUID,
        },
      })
    );
    const privateKey = await getLocalStorage("privateKey");
    const decPrivateKey = await decryptData(privateKey);
    if (privateKey) {
      await getMarkdown(message, decPrivateKey);
    }
  }
};

const parseValue = (value) => {
  try {
    return JSON.parse(value);
  } catch (e) {
    return value;
  }
};

function getLocalStorage(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local
      .get([key])
      .then((data) => {
        resolve(parseValue(data[key]));
      })
      .catch(reject);
  });
}

function setLocalStorage(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local
      .set({ [key]: JSON.stringify(value) })
      .then(() => {
        resolve();
      })
      .catch(reject);
  });
}

function clearLocalStorage() {
  chrome.storage.local.clear(function () {
    if (chrome.runtime.lastError) {
      console.error("Error clearing storage:", chrome.runtime.lastError);
    } else {
      console.log("Storage cleared successfully!");
    }
  });
}

// Connectivity check

async function getMarkdown(JobData, privateKey) {
  // const JobData = value?.data;

  // Ensure the dataset is valid before parsing
  let parsedData;

  if (JobData?.Dataset) {
    try {
      // Try to parse the Dataset if it exists
      parsedData = JSON.parse(JobData?.Dataset);

      // Optionally log the parsed data for debugging
    } catch (err) {
      console.error("Error parsing Dataset:", err);
      console.error("Invalid Dataset data:", JobData.Dataset);
      return; // Exit the function if Dataset is invalid
    }
  } else {
    console.log("dataset is missing or invalid.");
  }

  const bucketName = parsedData?.name;
  if (!bucketName) {
    console.error("No bucket name found in parsed dataset.");
    return;
  }

  // Ensure the payload is valid before parsing
  let payload;
  try {
    payload = JobData?.Payload ? JSON.parse(JobData?.Payload) : null;
  } catch (err) {
    console.error("Error parsing payload:", err);
    return; // Exit the function if payload is invalid
  }

  const urls = payload?.urls || [];
  if (urls.length === 0) {
    console.error("No URLs found in payload.");
    return;
  }

  const wallet = new ethers.Wallet(privateKey); // Using dynamic private key

  // Loop through URLs and fetch data
  let signedDataArray = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      // const response = await fetch(`next/server/api/hello?url=${urls[i]}`);
      const response = await getScrape(urls[i]);

      if (response?.success) {
        const data = response;

        const markdownData = JSON.stringify(data?.data?.markdown, null, 2);

        const sequenceNumber = (i + 1).toString().padStart(4, "0");
        // const objectKey = `${wallet?.address}/${JobData?.Type}/${JobData?.UUID}/${sequenceNumber}.md`;
        const objectKey = `${wallet.address}/${JobData.Type}/${JobData.UUID}_${sequenceNumber}.md`;

        // Assuming uploadToMinIO is defined elsewhere
        let SignedData = await uploadMinio(
          bucketName,
          objectKey,
          markdownData,
          JobData,
          privateKey
        );

        SignedData && signedDataArray?.push(SignedData);
      } else {
        console.error("Failed to fetch data for URL:", urls[i]);
      }
    } catch (err) {
      console.error("Error fetching or uploading data:", err);
    }
  }
  if (signedDataArray?.length > 0) {
    const message = {
      completed_at: new Date().toISOString(),
      message: "",
      output: "",
      ref: JobData?.UUID,
      status: true,
      tx_requests: signedDataArray,
    };

    if (socket) {
      socket.send(
        JSON.stringify({
          workerID: base64Encode(wallet?.address),
          msgType: "JOB_COMPLETION",
          workerType: "LWEXT",
          message,
        })
      );
    }
  } else {
    console.warn("No valid data to send.");
  }
}

async function uploadMinio(
  bucketName,
  objectKey,
  data,
  jobData,
  privateKey,
  contentType = "text/markdown",
  maxRetries = 3
) {
  const credentialUrl = process.env.NEXT_PUBLIC_S3_MINIO_CREDENTIALS_URL;
  let auth_token = await getLocalStorage("auth_token");

  const credentials = await getCredentials(
    credentialUrl,
    auth_token,
    jobData?.UUID
  );

  const s3Client = new S3Client({
    endpoint: process.env.NEXT_PUBLIC_S3_ENDPOINT,
    region: process.env.NEXT_PUBLIC_S3_REGION,
    // credentials: {
    //   accessKeyId: "FWF2K7x5zHGDHRRXvRkX",
    //   secretAccessKey: "SD39rzABNmiLlHH6CoLBXv3H836JQyFPKhnz0vqB",
    // },
    credentials,
    forcePathStyle: true,
    tls: true,
    maxAttempts: 3,
    requestHandlerOptions: {
      timeout: 10000,
    },
  });
  const bodyBuffer = Buffer.from(data, "utf-8");
  const checksum = SHA256(bodyBuffer).toString();
  const checksumCreateTime = new Date().getTime();
  const params = {
    Bucket: bucketName,
    Key: objectKey,
    Body: bodyBuffer,
    ContentType: contentType,
  };

  let retries = 0;
  while (retries < maxRetries) {
    try {
      const commend = new PutObjectCommand(params);
      const response = await s3Client.send(commend);

      storeJobData(jobData);

      let signedData = ethersConnect(
        jobData,
        checksum,
        checksumCreateTime,
        privateKey
      );
      return signedData;
      break;
    } catch (error) {
      retries++;
      console.error("Error uploading to MinIO:", error?.message, error);

      if (retries === maxRetries) {
      } else {
        console.log(`Retrying upload... Attempt ${retries + 1}`);
      }
    }
  }
  return { checksum, checksumCreateTime };
}

const storeJobData = async (jobData, jobReceviedresponse = "data") => {
  try {
    const existingData = await getLocalStorage("allJobData");

    const jobDataArray = existingData ? JSON.parse(existingData) : [];

    // Check  same UUID already exists
    const jobExists = jobDataArray?.some((job) => job?.UUID === jobData?.UUID);

    if (!jobExists) {
      const jobEntry = jobReceviedresponse
        ? { ...jobData, jobReceviedresponse }
        : jobData;
      jobDataArray.push(jobEntry);

      setLocalStorage("allJobData", JSON.stringify(jobDataArray));
    } else {
    }
  } catch (error) {
    console.error("Error saving job data:", error);
  }
};

async function ethersConnect(
  jobData,
  checksum,
  checksumCreateTime,
  privateKey
) {
  // Ensure ethers is imported and available
  if (!ethers) {
    console.error(
      "ethers is undefined. Make sure ethers is imported correctly."
    );
    return;
  }

  const wallet = new ethers.Wallet(privateKey);

  let dataset =
    typeof jobData.Dataset === "string"
      ? JSON.parse(jobData.Dataset)
      : jobData.Dataset;

  let worker = wallet?.address;
  let dataNetAddress = dataset.contractAddress;
  let dataNetReference = dataset.name;
  let dataNetRequestAt = 1344537000;
  let JobReference = jobData?.UUID;
  let storageReference = `${wallet?.address}/${jobData.Type}`;
  let storageChecksum = checksum;
  let storagedAt = checksumCreateTime;

  // let signedDataArray = [];

  // Check each parameter type to ensure everything is correct

  let params = [
    worker,
    dataNetAddress,
    dataNetReference,
    dataNetRequestAt,
    JobReference,
    storageReference,
    storageChecksum,
    storagedAt,
  ];

  try {
    // Check if `solidityKeccak256` is available before calling
    if (!ethers.solidityPackedKeccak256) {
      console.error("solidityKeccak256 method is unavailable.");
      return;
    }

    // Call `solidityKeccak256` with the correct types
    let hash = ethers.solidityPackedKeccak256(
      [
        "string", // worker
        "string", // dataNetAddress
        "string", // dataNetReference
        "uint256", // dataNetRequestAt (string format)
        "string", // JobReference
        "string", // storageReference
        "string", // storageChecksum
        "uint256", // storagedAt
      ],
      params
    );

    // Handle null or invalid hash
    if (!hash) {
      console.error("Error: Hash calculation resulted in null.");
      return;
    }

    // Sign the message with the wallet's private key
    let signature = await wallet.signMessage(ethers.getBytes(hash));

    const jobWithSign = {
      ref: JobReference,
      status: true,
      message: "",
      completed_at: storagedAt,
      output: "",
      job_details: {
        worker,
        dataNetAddress,
        dataNetReference,
        dataNetRequestAt,
        JobReference,
        storageReference,
        storageChecksum,
        storagedAt,
      },
      signature,
    };

    return {
      job_details: jobWithSign.job_details,
      signature: jobWithSign.signature,
    };
  } catch (error) {
    console.error("Error in ethersConnect:", error);
    return null;
  }
}

async function getAvailableMemoryPercentage() {
  // Check if the Chrome memory API is available
  if (chrome.system && chrome.system.memory) {
    try {
      // Get memory info
      const memoryInfo = await new Promise((resolve, reject) => {
        chrome.system.memory.getInfo((info) => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(info);
          }
        });
      });

      // Calculate available memory percentage
      const totalMemory = memoryInfo.capacity;
      const availableMemory = memoryInfo.availableCapacity;

      const availableMemoryPercentage = (
        (availableMemory / totalMemory) *
        100
      ).toFixed(2);

      return {
        totalMemory,
        availableMemory,
        availableMemoryPercentage: parseFloat(availableMemoryPercentage),
      };
    } catch (error) {
      console.error("Error getting memory information:", error);
      return null;
    }
  } else {
    console.warn("Chrome system memory API not available");
    return null;
  }
}

async function getAvailableStoragePercentage() {
  try {
    const { quota, usage } = await navigator.storage.estimate();

    const availableStorage = quota - usage;
    const availableStoragePercentage = (availableStorage / quota) * 100;

    return availableStoragePercentage.toFixed(2); // Percentage with 2 decimal points
  } catch (error) {
    console.error("Error calculating storage usage:", error);
    return null;
  }
}

// Decrypt data function
const encryptData = async (data) => {
  try {
    const userInfo = await getLocalStorage("userInfo");
    let secretKey = base64Encode(JSON?.parse(userInfo)?.email);
    // Convert data to bytes
    const dataBytes = toUtf8Bytes(data);

    // Create a random initialization vector (IV)
    const iv = randomBytes(16);

    // Derive encryption key using SHA256
    const keyBytes = sha256(toUtf8Bytes(secretKey));

    // XOR the data with the key (simple encryption)
    const encrypted = new Uint8Array(dataBytes.length);
    for (let i = 0; i < dataBytes.length; i++) {
      encrypted[i] = dataBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    // Combine IV and encrypted data
    const combined = new Uint8Array(iv.length + encrypted.length);
    combined.set(iv);
    combined.set(encrypted, iv.length);

    // Convert to hex string for storage/transmission
    return hexlify(combined);
  } catch (error) {
    throw new Error(`Encryption failed: ${error.message}`);
  }
};

const decryptData = async (encryptedHex) => {
  try {
    const userInfo = await getLocalStorage("userInfo");
    let secretKey = base64Encode(JSON?.parse(userInfo)?.email);
    // Convert hex string back to bytes
    const combined = getBytes(encryptedHex);

    // Extract IV and encrypted data
    const iv = combined.slice(0, 16);
    const encrypted = combined.slice(16);

    // Derive decryption key using SHA256
    const keyBytes = sha256(toUtf8Bytes(secretKey));

    // XOR the encrypted data with the key to decrypt
    const decrypted = new Uint8Array(encrypted.length);
    for (let i = 0; i < encrypted.length; i++) {
      decrypted[i] = encrypted[i] ^ keyBytes[i % keyBytes.length];
    }

    // Convert back to string
    return toUtf8String(decrypted);
  } catch (error) {
    throw new Error(`Decryption failed: ${error.message}`);
  }
};
