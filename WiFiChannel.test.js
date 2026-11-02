import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.connect();
const ONE_DAY = 24 * 3600;
const types = { Payment: [{ name: "channelId", type: "bytes32" }, { name: "cumulativeAmount", type: "uint256" }] };

async function fails(promise, text) {
  try { await promise; } catch (e) { expect(e.message).to.include(text); return; }
  expect.fail("la transaction aurait dû échouer : " + text);
}

describe("WiFiChannel", () => {
  let c, payer, payee, other, domain, id;
  const sign = (signer, amount, cid = id) =>
    signer.signTypedData(domain, types, { channelId: cid, cumulativeAmount: amount });

  beforeEach(async () => {
    [payer, payee, other] = await ethers.getSigners();
    c = await ethers.deployContract("WiFiChannel");
    domain = { name: "WiFiPaymentChannel", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await c.getAddress() };
    const tx = await c.connect(payer).openChannel(payee.address, { value: ethers.parseEther("0.01") });
    const rc = await tx.wait();
    console.log("      gaz ouverture :", rc.gasUsed.toString());
    id = rc.logs.map(l => c.interface.parseLog(l)).find(e => e?.name === "ChannelOpened").args.channelId;
  });

  it("fermeture coopérative par le fournisseur avec le dernier reçu", async () => {
    const amt = ethers.parseEther("0.003");
    const rc = await (await c.connect(payee).closeCooperative(id, amt, await sign(payer, amt))).wait();
    console.log("      gaz fermeture :", rc.gasUsed.toString());
    const ch = await c.channels(id);
    expect(ch.closed).to.equal(true);
    expect(ch.withdrawn).to.equal(amt);
  });

  it("le payeur ne peut pas clôturer avec un ancien reçu", async () => {
    const old = ethers.parseEther("0.001");
    await fails(c.connect(payer).closeCooperative(id, old, await sign(payer, old)), "only payee");
  });

  it("rejette une signature d'un tiers et un montant au-dessus du dépôt", async () => {
    const amt = ethers.parseEther("0.002");
    await fails(c.connect(payee).closeCooperative(id, amt, await sign(other, amt)), "invalid signature");
    const big = ethers.parseEther("0.02");
    await fails(c.connect(payee).closeCooperative(id, big, await sign(payer, big)), "amount > deposit");
  });

  it("contestation : le plus haut reçu gagne après le délai", async () => {
    await c.connect(payer).startUnilateralClose(id);
    const low = ethers.parseEther("0.001"), high = ethers.parseEther("0.004");
    await c.connect(payee).disputeWithSignature(id, high, await sign(payer, high));
    await fails(c.connect(payer).disputeWithSignature(id, low, await sign(payer, low)), "bad amount");
    await fails(c.finalizeUnilateralClose(id), "not ready");
    await networkHelpers.time.increase(ONE_DAY + 1);
    const rc = await (await c.finalizeUnilateralClose(id)).wait();
    console.log("      gaz finalisation :", rc.gasUsed.toString());
    const ch = await c.channels(id);
    expect(ch.closed).to.equal(true);
    expect(ch.withdrawn).to.equal(high);
    await fails(c.connect(payee).disputeWithSignature(id, high, await sign(payer, high)), "not in dispute");
  });

  it("identifiants uniques même avec les mêmes paramètres", async () => {
    const rc = await (await c.connect(payer).openChannel(payee.address, { value: 1n })).wait();
    const id2 = rc.logs.map(l => c.interface.parseLog(l)).find(e => e?.name === "ChannelOpened").args.channelId;
    expect(id2).to.not.equal(id);
    expect((await c.channels(id)).deposit).to.equal(ethers.parseEther("0.01"));
  });
});
