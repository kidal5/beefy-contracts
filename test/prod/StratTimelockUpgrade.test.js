const { expect } = require("chai");
const { addressBook } = require("blockchain-addressbook");

const { zapNativeToToken, getVaultWant, getUnirouterData, unpauseIfPaused } = require("../../utils/testHelpers");
const { delay } = require("../../utils/timeHelpers");

const TIMEOUT = 10 * 60 * 1000;

const chainName = "bsc";

const config = {
  vault: "0x41a6CdA789316B2Fa5D824EF27E4223872E4cB34",
  testAmount: ethers.utils.parseEther("1"),
  wnative: addressBook[chainName].tokens.WNATIVE.address,
  timelock: addressBook[chainName].platforms.beefyfinance.vaultOwner,
};

describe("StratUpgrade", () => {
  let timelock, vault, strategy, candidate, unirouter, want, keeper, upgrader, rewarder;

  before(async () => {
    [deployer, keeper, upgrader, rewarder] = await ethers.getSigners();

    vault = await ethers.getContractAt("BeefyVaultV6", config.vault);

    const strategyAddr = await vault.strategy();
    const stratCandidate = await vault.stratCandidate();

    strategy = await ethers.getContractAt("IStrategyComplete", strategyAddr);
    candidate = await ethers.getContractAt("IStrategyComplete", stratCandidate.implementation);
    timelock = await ethers.getContractAt(
      "@openzeppelin-4/contracts/governance/TimelockController.sol:TimelockController",
      config.timelock
    );

    const unirouterAddr = await strategy.unirouter();
    const unirouterData = getUnirouterData(unirouterAddr);
    unirouter = await ethers.getContractAt(unirouterData.interface, unirouterAddr);
    console.log(unirouterAddr, "addy");
    want = await getVaultWant(vault, config.wnative);

    await zapNativeToToken({
      amount: config.testAmount,
      want,
      nativeTokenAddr: config.wnative,
      unirouter,
      swapSignature: unirouterData.swapSignature,
      recipient: deployer.address,
    });

    const wantBal = await want.balanceOf(deployer.address);
    await want.transfer(keeper.address, wantBal.div(2));
  });

  it("New strat has the correct admin accounts", async () => {
    const { beefyfinance } = addressBook[chainName].platforms;
    expect(await candidate.keeper()).to.equal(beefyfinance.keeper);
    expect(await candidate.owner()).to.equal(beefyfinance.strategyOwner);
  }).timeout(TIMEOUT);

  it("Upgrades correctly", async () => {
    const vaultBal = await vault.balance();
    const strategyBal = await strategy.balanceOf();
    const candidateBal = await candidate.balanceOf();

    await timelock
      .connect(rewarder)
      .execute(
        config.vault,
        0,
        "0xe6685244",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000"
      );

    const vaultBalAfter = await vault.balance();
    const strategyBalAfter = await strategy.balanceOf();
    const candidateBalAfter = await candidate.balanceOf();

    expect(vaultBalAfter).to.be.within(vaultBal.mul(999).div(1000), vaultBal.mul(1001).div(1000));
    expect(strategyBal).not.to.equal(strategyBalAfter);
    expect(candidateBalAfter).to.be.within(strategyBal.mul(999).div(1000), strategyBal.mul(1001).div(1000));
    expect(candidateBal).not.to.equal(candidateBalAfter);

    console.log(vaultBal.toString());
    console.log(vaultBalAfter.toString());
    await delay(100000);
    let tx = candidate.harvest();

    const balBeforePanic = await candidate.balanceOf();
    tx = candidate.connect(keeper).panic();
    await expect(tx).not.to.be.reverted;
    const balAfterPanic = await candidate.balanceOf();
    expect(balBeforePanic).to.equal(balAfterPanic);
  }).timeout(TIMEOUT);

  it("Vault and strat references are correct after upgrade.", async () => {
    expect(await vault.strategy()).to.equal(candidate.address);
    expect(await candidate.vault()).to.equal(vault.address);
  }).timeout(TIMEOUT);

  it("User can deposit and withdraw from the vault.", async () => {
    await unpauseIfPaused(candidate, keeper);

    const wantBalStart = await want.balanceOf(deployer.address);

    await want.approve(vault.address, wantBalStart);
    await vault.depositAll();
    await vault.withdrawAll();

    const wantBalFinal = await want.balanceOf(deployer.address);

    expect(wantBalFinal).to.be.lte(wantBalStart);
    expect(wantBalFinal).to.be.gt(wantBalStart.mul(95).div(100));
  }).timeout(TIMEOUT);

  it("New user doesn't lower other users balances.", async () => {
    await unpauseIfPaused(candidate, keeper);

    const wantBalStart = await want.balanceOf(deployer.address);
    await want.approve(vault.address, wantBalStart);
    await vault.depositAll();

    const pricePerShare = await vault.getPricePerFullShare();
    const wantBalOfOther = await want.balanceOf(upgrader.address);
    await want.connect(upgrader).approve(vault.address, wantBalOfOther);
    await vault.connect(upgrader).depositAll();
    const pricePerShareAfter = await vault.getPricePerFullShare();

    expect(pricePerShareAfter).to.be.gte(pricePerShare);

    await vault.withdrawAll();
    const wantBalFinal = await want.balanceOf(deployer.address);
    expect(wantBalFinal).to.be.within(wantBalStart.mul(99).div(100), wantBalStart.mul(101).div(100));
  }).timeout(TIMEOUT);
});
