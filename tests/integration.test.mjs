import { test } from "node:test";
import assert from "node:assert/strict";
import {
  calculateCollateralRatio,
  calculateMaxMintableDebt,
  calculateLiquidationSeizure,
  isVaultSolvent,
  WAD,
  BPS_DIVISOR
} from "@qmoosa/stablecoin-protocol";
import { StablecoinEngine } from "@qmoosa/stablecoin-engine";
import { StablecoinClient, generateKeyPair } from "@qmoosa/stablecoin-sdk";

function setupIntegrationSystem() {
  const { publicKey, privateKey } = generateKeyPair();
  const engine = new StablecoinEngine(publicKey, 31337);

  engine.registerCollateralDirect({
    token: "WETH",
    symbol: "WETH",
    decimals: 18,
    minCollateralRatioBps: 15000n, // 150%
    liquidationPenaltyBps: 1000n,  // 10%
    stabilityFeeBps: 200n,         // 2% APR
    debtCeiling: 10_000_000n * WAD,
    totalDebtIssued: 0n,
    isPaused: false
  });

  engine.setOraclePriceDirect("WETH", 3000n * WAD);

  const alice = "0xAliceCDPOwner11111111111111111111111111";
  engine.setUserCollateralBalance(alice, "WETH", 50n * WAD);

  const liquidator = "0xBobLiquidator22222222222222222222222222";
  engine.setUserStablecoinBalance(liquidator, 100_000n * WAD);

  const client = new StablecoinClient(engine, {
    vaultManagerAddress: "0xQmoosaVaultManagerV1",
    defaultDeadlineSeconds: 600
  });

  return { engine, client, alice, liquidator, publicKey, privateKey };
}

test("1. Cross-Repo Mathematical Invariant Verification", () => {
  const collValue = 30_000n * WAD;
  const debt = 10_000n * WAD;

  // Protocol math
  const ratio = calculateCollateralRatio(collValue, debt);
  assert.equal(ratio, 30000n);

  const maxMint = calculateMaxMintableDebt(collValue, 15000n, debt);
  assert.equal(maxMint, 10_000n * WAD); // 30k / 1.5 = 20k max debt -> 10k additional

  const solvent = isVaultSolvent(collValue, debt, 15000n);
  assert.equal(solvent, true);

  const { collateralToSeize, penaltyCollateral } = calculateLiquidationSeizure(
    5_000n * WAD,
    2000n * WAD,
    18,
    1000n
  );
  // 5000 debt * 1.1 = $5500 value. At $2000/ETH = 2.75 ETH
  assert.equal(collateralToSeize, (275n * WAD) / 100n);
  assert.equal(penaltyCollateral, (25n * WAD) / 100n); // 0.25 ETH bonus
});

test("2. End-to-End Multi-Repo CDP Deposit, Mint, Repay & Solvency Lifecycle", async () => {
  const { client, alice } = setupIntegrationSystem();

  // 1. Open Vault
  const vault = client.openVault(alice, "WETH");
  assert.equal(vault.owner, alice);

  // 2. Deposit 10 WETH ($30,000 value)
  const dep = await client.executeDeposit(vault.vaultId, alice, 10n * WAD);
  assert.equal(dep.success, true);
  assert.equal(dep.collateralRatioAfterBps, 100000000n);

  // 3. Mint 12,000 QUSD (250% ratio, well above 150%)
  const mint = await client.executeMint(vault.vaultId, alice, 12_000n * WAD);
  assert.equal(mint.success, true);
  assert.equal(mint.debtDelta, 12_000n * WAD);

  const health1 = client.getVaultHealth(vault.vaultId);
  assert.equal(health1.isSolvent, true);
  assert.equal(health1.collateralRatioBps, 25000n);

  // 4. Repay 6,000 QUSD
  const repay = await client.executeRepay(vault.vaultId, alice, 6_000n * WAD);
  assert.equal(repay.success, true);

  const health2 = client.getVaultHealth(vault.vaultId);
  assert.equal(health2.totalDebtWad, 6_000n * WAD);
  assert.equal(health2.collateralRatioBps, 50000n); // 500% ratio
});

test("3. Multi-Repo Liquidation Execution & Collateral Seizure under Market Stress", async () => {
  const { engine, client, alice, liquidator } = setupIntegrationSystem();

  const vault = client.openVault(alice, "WETH");
  await client.executeDeposit(vault.vaultId, alice, 10n * WAD);
  await client.executeMint(vault.vaultId, alice, 18_000n * WAD); // $18k debt (166% ratio at $3000)

  // Market crash: ETH drops to $1800 -> 10 ETH = $18,000 value. Ratio = 100% (< 150%)
  engine.setOraclePriceDirect("WETH", 1800n * WAD);

  const healthBefore = client.getVaultHealth(vault.vaultId);
  assert.equal(healthBefore.isSolvent, false);
  assert.equal(healthBefore.isLiquidatable, true);

  // Liquidator repays 10,000 QUSD
  const liq = await client.executeLiquidate(vault.vaultId, liquidator, 10_000n * WAD);
  assert.equal(liq.success, true);
  assert.equal(liq.operation, "LIQUIDATE");

  // With 10% penalty: 10,000 * 1.1 = $11,000 value. At $1800/ETH = 6.111... ETH
  const liqCollateral = engine.getUserCollateralBalance(liquidator, "WETH");
  assert.ok(liqCollateral > 6n * WAD);

  const healthAfter = client.getVaultHealth(vault.vaultId);
  assert.equal(healthAfter.totalDebtWad, 8_000n * WAD);
});
