import { ethers } from "ethers";

// Configuration
const CONTRACT_ADDRESS = "0x34E54c08b0F1e0d2a3f50Eef449cf4b90A6C4c86"; 
const CHAIN_ID = 11155111n;
const PAYEE_ADDRESS = "0xA32C0d77f35BB2b8ff80AC57761A10ECf1ccbE62"; 

const CONTRACT_ABI = [
    "function openChannel(address payee) external payable returns (bytes32)",
    "function closeCooperative(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature) external",
    "event ChannelOpened(bytes32 indexed channelId, address payer, address payee, uint256 deposit)"
];

let provider, signer, contract, userAddress;
let currentChannelId = null;
let minutesPaid = 0;

const connectBtn = document.getElementById("connect-btn");
const networkStatus = document.getElementById("network-status");
const walletBalance = document.getElementById("wallet-balance");
const walletAddress = document.getElementById("wallet-address");
const pageTitle = document.getElementById("page-title");

// Navigation
document.querySelectorAll(".nav-item").forEach(item => {
    item.addEventListener("click", (e) => {
        e.preventDefault();
        document.querySelectorAll(".nav-item").forEach(i => i.classList.remove("active"));
        document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
        item.classList.add("active");
        const target = item.getAttribute("data-target");
        document.getElementById(target).classList.add("active");
        if(pageTitle) pageTitle.textContent = item.textContent.trim();
    });
});

function log(msg) {
    const list = document.getElementById("log-list");
    if(!list) return;
    const li = document.createElement("li");
    li.textContent = msg;
    list.appendChild(li);
    list.parentElement.scrollTop = list.parentElement.scrollHeight;
}

async function connectWallet() {
    if (!window.ethereum) return alert("Installez MetaMask !");
    try {
        const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
        userAddress = accounts[0];
        provider = new ethers.BrowserProvider(window.ethereum);
        signer = await provider.getSigner();
        contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

        const network = await provider.getNetwork();
        if (network.chainId !== CHAIN_ID) {
            alert("Veuillez passer sur le réseau Sepolia.");
            return;
        }

        if(connectBtn) connectBtn.classList.add("hidden");
        if(walletAddress) {
            walletAddress.classList.remove("hidden");
            walletAddress.textContent = `${userAddress.slice(0, 6)}...${userAddress.slice(-4)}`;
        }
        if(networkStatus) {
            networkStatus.textContent = "Sepolia Connecté";
            networkStatus.className = "badge badge-success";
        }
        
        const balance = await provider.getBalance(userAddress);
        if(walletBalance) walletBalance.textContent = ethers.formatEther(balance).slice(0, 6) + " ETH";
        
        log("Portefeuille connecté : " + userAddress);

    } catch (err) {
        console.error(err);
        log("Erreur de connexion.");
    }
}

if(connectBtn) connectBtn.addEventListener("click", connectWallet);

const openChannelBtn = document.getElementById("open-channel-btn");
if(openChannelBtn) openChannelBtn.addEventListener("click", async () => {
    try {
        log("Envoi de la transaction d'ouverture...");
        const tx = await contract.openChannel(PAYEE_ADDRESS, { value: ethers.parseEther("0.01") });
        const receipt = await tx.wait();
        
        const event = receipt.logs.map(l => { try { return contract.interface.parseLog(l); } catch { return null; } }).find(e => e?.name === "ChannelOpened");
        
        if (event) {
            currentChannelId = event.args.channelId;
            const statusEl = document.getElementById("channel-status");
            const idEl = document.getElementById("channel-id");
            if(statusEl) statusEl.textContent = "Ouvert";
            if(idEl) idEl.textContent = currentChannelId.slice(0, 10) + "...";
            
            const statDeposit = document.getElementById("stat-deposit");
            if(statDeposit) statDeposit.textContent = "0.01 ETH";
            
            openChannelBtn.classList.add("hidden");
            const payBtn = document.getElementById("pay-minute-btn");
            const closeBtn = document.getElementById("close-channel-btn");
            if(payBtn) payBtn.classList.remove("hidden");
            if(closeBtn) closeBtn.classList.remove("hidden");
            
            log("Canal ouvert ! ID: " + currentChannelId.slice(0, 10));
        }
    } catch (err) {
        console.error(err);
        log("Erreur d'ouverture du canal.");
    }
});

const payMinuteBtn = document.getElementById("pay-minute-btn");
if(payMinuteBtn) payMinuteBtn.addEventListener("click", async () => {
    try {
        const nextMinute = minutesPaid + 1;
        const cumulativeAmount = BigInt(nextMinute) * ethers.parseEther("0.001");

        const domain = { name: "WiFiPaymentChannel", version: "1", chainId: CHAIN_ID, verifyingContract: CONTRACT_ADDRESS };
        const types = { Payment: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };
        const value = { channelId: currentChannelId, cumulativeAmount: cumulativeAmount };

        log(`Demande de signature pour la minute ${nextMinute}...`);
        const signature = await signer.signTypedData(domain, types, value);
        
        minutesPaid = nextMinute;
        const statMinutes = document.getElementById("stat-minutes");
        const statSigned = document.getElementById("stat-signed");
        if(statMinutes) statMinutes.textContent = minutesPaid;
        if(statSigned) statSigned.textContent = ethers.formatEther(cumulativeAmount) + " ETH";
        
        log(`✅ Signature validée (${ethers.formatEther(cumulativeAmount)} ETH).`);
        
        window.lastSignature = signature;
        window.lastCumulativeAmount = cumulativeAmount;

    } catch (err) {
        console.error(err);
        log("Signature annulée.");
    }
});

const closeChannelBtn = document.getElementById("close-channel-btn");
if(closeChannelBtn) closeChannelBtn.addEventListener("click", async () => {
    if (!window.lastSignature) return alert("Signez au moins 1 minute d'abord !");
    
    try {
        log("Fermeture coopérative du canal...");
        const tx = await contract.closeCooperative(currentChannelId, window.lastCumulativeAmount, window.lastSignature);
        await tx.wait();
        
        log("✅ Canal fermé. Fonds répartis.");
        
        const statusEl = document.getElementById("channel-status");
        if(statusEl) statusEl.textContent = "Fermé";
        
        if(payMinuteBtn) payMinuteBtn.classList.add("hidden");
        closeChannelBtn.classList.add("hidden");
        if(openChannelBtn) openChannelBtn.classList.remove("hidden");
        
        minutesPaid = 0;
        window.lastSignature = null;
    } catch (err) {
        console.error(err);
        log("Erreur de fermeture.");
    }
});