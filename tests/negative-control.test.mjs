import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StablecoinEngine, AdminAuthManager, WAD } from "@qmoosa/stablecoin-engine";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

function setupAdversarialSystem() {
  const { publicKey, privateKey } = AdminAuthManager.generateKeyPair();
  const engine = new StablecoinEngine(publicKey, 31337);

  engine.registerCollateralDirect({
    token: "WETH",
    symbol: "WETH",
    decimals: 18,
    minCollateralRatioBps: 15000n, // 150%
    liquidationPenaltyBps: 1000n,  // 10%
    stabilityFeeBps: 200n,
    debtCeiling: 100_000n * WAD,  // 100k ceiling
    totalDebtIssued: 0n,
    isPaused: false
  });

  engine.setOraclePriceDirect("WETH", 3000n * WAD);

  const alice = "0xAlice1111111111111111111111111111111111";
  engine.setUserCollateralBalance(alice, "WETH", 50n * WAD);

  const attacker = "0xAttacker6666666666666666666666666666666666";
  engine.setUserStablecoinBalance(attacker, 500_000n * WAD);

  return { engine, publicKey, privateKey, alice, attacker };
}

test("Negative Control 1: Undercollateralized minting strictly fails closed with zero mutation", () => {
  const { engine, alice } = setupAdversarialSystem();
  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD); // $30k value, max debt = 20k

  assert.throws(
    () => engine.mintStablecoin(vault.vaultId, alice, 25_000n * WAD),
    /MINT_BREAKS_SOLVENCY/
  );

  const v = engine.getVault(vault.vaultId);
  assert.equal(v.debtAmount, 0n);
  assert.equal(engine.getUserStablecoinBalance(alice), 0n);
});

test("Negative Control 2: Unauthorized collateral withdrawal violating minimum ratio strictly fails closed", () => {
  const { engine, alice } = setupAdversarialSystem();
  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 10_000n * WAD); // 10k debt

  // Withdrawing 6 ETH leaves 4 ETH ($12k value), ratio drops to 120% (< 150%)
  assert.throws(
    () => engine.withdrawCollateral(vault.vaultId, alice, 6n * WAD),
    /WITHDRAWAL_BREAKS_SOLVENCY/
  );

  const v = engine.getVault(vault.vaultId);
  assert.equal(v.collateralAmount, 10n * WAD);
});

test("Negative Control 3: Debt ceiling breach strictly rejected", () => {
  const { engine, alice } = setupAdversarialSystem();
  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 50n * WAD); // $150k value

  // Debt ceiling is 100k, attempting to mint 105k
  assert.throws(
    () => engine.mintStablecoin(vault.vaultId, alice, 105_000n * WAD),
    /DEBT_CEILING_BREACHED/
  );

  const v = engine.getVault(vault.vaultId);
  assert.equal(v.debtAmount, 0n);
});

test("Negative Control 4: Hostile liquidator cannot liquidate a healthy solvent vault", () => {
  const { engine, alice, attacker } = setupAdversarialSystem();
  const vault = engine.openVault(alice, "WETH");
  engine.depositCollateral(vault.vaultId, alice, 10n * WAD);
  engine.mintStablecoin(vault.vaultId, alice, 5_000n * WAD); // 600% ratio (super healthy)

  assert.throws(
    () => engine.liquidateVault(vault.vaultId, attacker, 2_000n * WAD),
    /VAULT_IS_SOLVENT/
  );

  const v = engine.getVault(vault.vaultId);
  assert.equal(v.collateralAmount, 10n * WAD);
  assert.equal(v.debtAmount, 5_000n * WAD);
});

test("Negative Control 5: Forged Ed25519 administrative signature strictly fails closed", () => {
  const { engine } = setupAdversarialSystem();
  const { privateKey: fakeKey } = AdminAuthManager.generateKeyPair();

  const now = Math.floor(Date.now() / 1000);
  const forgedIntent = AdminAuthManager.signAdminIntent(
    "SET_ORACLE_PRICE",
    { token: "WETH", priceWad: 10_000n * WAD },
    1,
    now + 3600,
    "QMOOSA:STABLECOIN_ENGINE:31337",
    fakeKey // signed with wrong key
  );

  assert.throws(
    () => engine.executeAdminIntent(forgedIntent),
    /Cryptographic verification failed/
  );
});

test("Negative Control 6: Nonce replay attack strictly fails closed", () => {
  const { engine, privateKey } = setupAdversarialSystem();

  const now = Math.floor(Date.now() / 1000);
  const intent = AdminAuthManager.signAdminIntent(
    "SET_ORACLE_PRICE",
    { token: "WETH", priceWad: 4000n * WAD },
    1,
    now + 3600,
    "QMOOSA:STABLECOIN_ENGINE:31337",
    privateKey
  );

  engine.executeAdminIntent(intent);

  // Second execution of same nonce
  assert.throws(
    () => engine.executeAdminIntent(intent),
    /Nonce replay rejected/
  );
});

test("Negative Control 7: Deliberate provenance tampering causes verify:archive to fail with exit code 1", () => {
  const archivePath = path.join(rootDir, "packages", "qmoosa-stablecoin-protocol-1.0.0.tgz");
  const original = fs.readFileSync(archivePath);
  try {
    fs.appendFileSync(archivePath, "CORRUPT_BYTES");
    assert.throws(
      () => execSync("node scripts/verify-source-integrity.mjs --mode=archive", {
        cwd: rootDir,
        stdio: "pipe"
      }),
      /Command failed/
    );
  } finally {
    fs.writeFileSync(archivePath, original);
  }
});

