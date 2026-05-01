import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_X402_REPO_DIR = path.resolve(SCRIPT_DIR, "../../zeko-x402");

const BASE_CONFIG = {
  rail: "base",
  networkLabel: "base-mainnet",
  chainImport: "base",
  rpcEnvNames: ["X402_BASE_RPC_URL", "X402_BASE_MAINNET_RPC_URL", "BASE_RPC_URL"],
  privateKeyEnvNames: [
    "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_PRIVATE_KEY",
    "X402_BASE_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ],
  defaultRpcUrl: "https://mainnet.base.org",
  usdcAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  wethAddress: "0x4200000000000000000000000000000000000006",
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
};

const ETHEREUM_CONFIG = {
  rail: "ethereum",
  networkLabel: "ethereum-mainnet",
  chainImport: "mainnet",
  rpcEnvNames: ["X402_ETHEREUM_RPC_URL", "X402_ETHEREUM_MAINNET_RPC_URL", "ETHEREUM_RPC_URL"],
  privateKeyEnvNames: [
    "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_PRIVATE_KEY",
    "X402_ETHEREUM_RELAYER_PRIVATE_KEY",
    "X402_EVM_RELAYER_PRIVATE_KEY"
  ],
  defaultRpcUrl: "https://ethereum-rpc.publicnode.com",
  usdcAddress: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  wethAddress: "0xC02aaA39b223FE8D0A0e5C4F27ead9083C756Cc2",
  swapRouter02: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
  quoterV2: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"
};

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = "true";
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function optionalEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function requiredEnv(...names) {
  const value = optionalEnv(...names);
  if (!value) {
    throw new Error(`Missing required env var: ${names.join(" or ")}`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage:
  pnpm top-up:facilitator-gas -- --rail base --swap-usdc 5 --min-native-eth 0.003
  pnpm top-up:facilitator-gas -- --rail base --swap-usdc 5 --min-native-eth 0.003 --execute

Options:
  --rail base|ethereum        Facilitator rail to top up. Defaults to base.
  --swap-usdc <amount>        USDC amount to swap when native gas is below threshold.
  --min-native-eth <amount>   Native ETH threshold. If balance is at or above this, no swap runs.
  --pool-fee <fee>            Uniswap V3 pool fee. Defaults to 500.
  --slippage-bps <bps>        Slippage guard for quoted output. Defaults to 100.
  --execute                   Broadcast approve/swap transactions. Without this, dry-run only.
  --x402-repo-dir <path>      Local zeko-x402 repo used for viem dependencies. Defaults to ../zeko-x402.
  --help                      Show this message.

Environment:
  Base RPC: X402_BASE_RPC_URL or X402_BASE_MAINNET_RPC_URL
  Base key: CLAWZ_BASE_FACILITATOR_GAS_TOPUP_PRIVATE_KEY or X402_BASE_RELAYER_PRIVATE_KEY
  Ethereum RPC: X402_ETHEREUM_RPC_URL or X402_ETHEREUM_MAINNET_RPC_URL
  Ethereum key: CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_PRIVATE_KEY or X402_ETHEREUM_RELAYER_PRIVATE_KEY
`);
}

function railConfig(rail) {
  return rail === "ethereum" ? ETHEREUM_CONFIG : BASE_CONFIG;
}

function readConfig(args) {
  const config = railConfig(String(args.rail ?? "base").toLowerCase());
  const swapUsdc =
    args["swap-usdc"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_SWAP_USDC"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_SWAP_USDC",
      "CLAWZ_FACILITATOR_GAS_TOPUP_SWAP_USDC"
    );
  const minNativeEth =
    args["min-native-eth"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH",
      "CLAWZ_FACILITATOR_GAS_TOPUP_MIN_NATIVE_ETH"
    ) ??
    (config.rail === "ethereum" ? "0.03" : "0.003");
  const slippageBps =
    args["slippage-bps"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS",
      "CLAWZ_FACILITATOR_GAS_TOPUP_SLIPPAGE_BPS"
    ) ??
    "100";
  const poolFee =
    args["pool-fee"] ??
    optionalEnv(
      config.rail === "ethereum"
        ? "CLAWZ_ETHEREUM_FACILITATOR_GAS_TOPUP_POOL_FEE"
        : "CLAWZ_BASE_FACILITATOR_GAS_TOPUP_POOL_FEE",
      "CLAWZ_FACILITATOR_GAS_TOPUP_POOL_FEE"
    ) ??
    "500";

  if (!swapUsdc) {
    throw new Error("Pass --swap-usdc or set CLAWZ_FACILITATOR_GAS_TOPUP_SWAP_USDC.");
  }

  return {
    ...config,
    rpcUrl: optionalEnv(...config.rpcEnvNames) ?? config.defaultRpcUrl,
    privateKey: requiredEnv(...config.privateKeyEnvNames),
    swapUsdc,
    minNativeEth,
    slippageBps,
    poolFee,
    execute: args.execute === "true",
    x402RepoDir: args["x402-repo-dir"] ? path.resolve(String(args["x402-repo-dir"])) : DEFAULT_X402_REPO_DIR
  };
}

function topUpSnippet(config) {
  return `
    import {
      createPublicClient,
      createWalletClient,
      encodeFunctionData,
      formatUnits,
      getAddress,
      http,
      parseUnits
    } from "viem";
    import { privateKeyToAccount } from "viem/accounts";
    import { ${config.chainImport} as chain } from "viem/chains";

    const ERC20_ABI = [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }]
      },
      {
        type: "function",
        name: "allowance",
        stateMutability: "view",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" }
        ],
        outputs: [{ name: "", type: "uint256" }]
      },
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" }
        ],
        outputs: [{ name: "", type: "bool" }]
      }
    ];

    const QUOTER_V2_ABI = [
      {
        type: "function",
        name: "quoteExactInputSingle",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "params",
            type: "tuple",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "fee", type: "uint24" },
              { name: "sqrtPriceLimitX96", type: "uint160" }
            ]
          }
        ],
        outputs: [
          { name: "amountOut", type: "uint256" },
          { name: "sqrtPriceX96After", type: "uint160" },
          { name: "initializedTicksCrossed", type: "uint32" },
          { name: "gasEstimate", type: "uint256" }
        ]
      }
    ];

    const SWAP_ROUTER_ABI = [
      {
        type: "function",
        name: "exactInputSingle",
        stateMutability: "payable",
        inputs: [
          {
            name: "params",
            type: "tuple",
            components: [
              { name: "tokenIn", type: "address" },
              { name: "tokenOut", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "recipient", type: "address" },
              { name: "amountIn", type: "uint256" },
              { name: "amountOutMinimum", type: "uint256" },
              { name: "sqrtPriceLimitX96", type: "uint160" }
            ]
          }
        ],
        outputs: [{ name: "amountOut", type: "uint256" }]
      },
      {
        type: "function",
        name: "unwrapWETH9",
        stateMutability: "payable",
        inputs: [
          { name: "amountMinimum", type: "uint256" },
          { name: "recipient", type: "address" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "multicall",
        stateMutability: "payable",
        inputs: [{ name: "data", type: "bytes[]" }],
        outputs: [{ name: "results", type: "bytes[]" }]
      }
    ];

    const account = privateKeyToAccount(process.env.TOPUP_PRIVATE_KEY);
    const publicClient = createPublicClient({ chain, transport: http(process.env.RPC_URL) });
    const walletClient = createWalletClient({ account, chain, transport: http(process.env.RPC_URL) });
    const usdcAddress = getAddress(process.env.USDC_ADDRESS);
    const wethAddress = getAddress(process.env.WETH_ADDRESS);
    const routerAddress = getAddress(process.env.SWAP_ROUTER_ADDRESS);
    const quoterAddress = getAddress(process.env.QUOTER_ADDRESS);
    const poolFee = Number(process.env.POOL_FEE);
    const slippageBps = BigInt(process.env.SLIPPAGE_BPS);
    const execute = process.env.EXECUTE === "true";
    const minNative = parseUnits(process.env.MIN_NATIVE_ETH, 18);
    const amountIn = parseUnits(process.env.SWAP_USDC, 6);
    const nativeBalanceBefore = await publicClient.getBalance({ address: account.address });
    const usdcBalanceBefore = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });

    if (nativeBalanceBefore >= minNative) {
      console.log(JSON.stringify({
        ok: true,
        action: "noop",
        reason: "native_balance_at_or_above_threshold",
        network: process.env.NETWORK_LABEL,
        relayer: account.address,
        nativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
        minNativeEth: process.env.MIN_NATIVE_ETH,
        usdcBalanceBefore: formatUnits(usdcBalanceBefore, 6)
      }));
      process.exit(0);
    }

    if (usdcBalanceBefore < amountIn) {
      throw new Error(
        \`Relayer \${account.address} has \${formatUnits(usdcBalanceBefore, 6)} USDC but needs \${process.env.SWAP_USDC} USDC to top up gas.\`
      );
    }

    const quoteSimulation = await publicClient.simulateContract({
      account,
      address: quoterAddress,
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [{
        tokenIn: usdcAddress,
        tokenOut: wethAddress,
        amountIn,
        fee: poolFee,
        sqrtPriceLimitX96: 0n
      }]
    });
    const quoteResult = quoteSimulation.result;
    const quotedAmountOut = Array.isArray(quoteResult) ? quoteResult[0] : quoteResult.amountOut;
    const amountOutMinimum = (quotedAmountOut * (10000n - slippageBps)) / 10000n;

    if (!execute) {
      console.log(JSON.stringify({
        ok: true,
        action: "dry_run",
        network: process.env.NETWORK_LABEL,
        relayer: account.address,
        nativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
        minNativeEth: process.env.MIN_NATIVE_ETH,
        swapUsdc: process.env.SWAP_USDC,
        quotedNativeOut: formatUnits(quotedAmountOut, 18),
        amountOutMinimum: formatUnits(amountOutMinimum, 18),
        slippageBps: Number(slippageBps),
        poolFee,
        routerAddress,
        quoterAddress
      }));
      process.exit(0);
    }

    const allowance = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, routerAddress]
    });
    let approvalHash;
    if (allowance < amountIn) {
      approvalHash = await walletClient.writeContract({
        address: usdcAddress,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [routerAddress, amountIn]
      });
      await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    }

    const swapCall = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInputSingle",
      args: [{
        tokenIn: usdcAddress,
        tokenOut: wethAddress,
        fee: poolFee,
        recipient: routerAddress,
        amountIn,
        amountOutMinimum,
        sqrtPriceLimitX96: 0n
      }]
    });
    const unwrapCall = encodeFunctionData({
      abi: SWAP_ROUTER_ABI,
      functionName: "unwrapWETH9",
      args: [amountOutMinimum, account.address]
    });
    const swapHash = await walletClient.writeContract({
      address: routerAddress,
      abi: SWAP_ROUTER_ABI,
      functionName: "multicall",
      args: [[swapCall, unwrapCall]]
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapHash });
    const nativeBalanceAfter = await publicClient.getBalance({ address: account.address });
    const usdcBalanceAfter = await publicClient.readContract({
      address: usdcAddress,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [account.address]
    });

    console.log(JSON.stringify({
      ok: true,
      action: "executed",
      network: process.env.NETWORK_LABEL,
      relayer: account.address,
      approvalHash,
      swapHash,
      receiptStatus: receipt.status,
      nativeBalanceBefore: formatUnits(nativeBalanceBefore, 18),
      nativeBalanceAfter: formatUnits(nativeBalanceAfter, 18),
      usdcBalanceBefore: formatUnits(usdcBalanceBefore, 6),
      usdcBalanceAfter: formatUnits(usdcBalanceAfter, 6),
      swapUsdc: process.env.SWAP_USDC,
      quotedNativeOut: formatUnits(quotedAmountOut, 18),
      amountOutMinimum: formatUnits(amountOutMinimum, 18),
      slippageBps: Number(slippageBps),
      poolFee,
      routerAddress,
      quoterAddress
    }));
  `;
}

async function runTopUp(config) {
  const { stdout } = await execFileAsync("node", ["--input-type=module", "-e", topUpSnippet(config)], {
    cwd: config.x402RepoDir,
    env: {
      ...process.env,
      NETWORK_LABEL: config.networkLabel,
      RPC_URL: config.rpcUrl,
      TOPUP_PRIVATE_KEY: config.privateKey,
      USDC_ADDRESS: config.usdcAddress,
      WETH_ADDRESS: config.wethAddress,
      SWAP_ROUTER_ADDRESS: config.swapRouter02,
      QUOTER_ADDRESS: config.quoterV2,
      SWAP_USDC: config.swapUsdc,
      MIN_NATIVE_ETH: config.minNativeEth,
      SLIPPAGE_BPS: config.slippageBps,
      POOL_FEE: config.poolFee,
      EXECUTE: config.execute ? "true" : "false"
    },
    maxBuffer: 1024 * 1024 * 20
  });
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines.at(-1));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === "true") {
    printHelp();
    return;
  }

  const config = readConfig(args);
  const result = await runTopUp(config);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error("[clawz:top-up-facilitator-gas] failed", error);
  process.exit(1);
});
