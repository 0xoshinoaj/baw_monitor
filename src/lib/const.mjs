/** 鏈上與分類共用常數。所有模組只從這裡讀地址，避免各寫各的。 */

export const CHAIN_ID = 56;
export const CHAIN_ID_HEX = '0x38';
export const BINANCE_CHAIN_ID = '56';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const NATIVE_BNB = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const USDT = '0x55d398326f99059ff775485246999027b3197955';
export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const USD1 = '0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d';

export const PCS_ROUTER = '0x10ed43c718714eb63d5aa57b78b54704e256024e';
export const PCS_FACTORY = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

/** 幣安 Agent ID NFT 登記合約：bytecode 出現它，或持有者抽樣持有它，即視為 Agent ID 專屬。 */
export const AGENT_ID_REGISTRY = '0x60b9262456de011f7d15a54cdd8c48baaa8b022f';
export const AGENT_ID_REGISTRY_BARE = AGENT_ID_REGISTRY.slice(2);

/** Open Four Registry（Core / Tools 由此讀出）。 */
export const OPEN_FOUR_REGISTRY = '0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94';
export const AGENT_ID_PRESET_ID = 1778027615735n;

export const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const TOPIC_UPGRADED = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b';
export const TOPIC_BEACON_UPGRADED = '0x1cf3b03a6cf19fa2baba4df148e9dcabedea7f8a5c07840e207e5c089be95d3e';

export const EIP1967_IMPL = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const EIP1967_BEACON = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const EIP1967_ADMIN = '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

/** 常見 CREATE2／工廠部署者。 */
export const CREATE2_DEPLOYERS = [
  '0x4e59b44847b379578588920ca78fbf26c0b4956c',
  '0xba5ed099633d3b313e4d5f7bdc1305d3c28ba5ed',
  '0x0000000000ffe8b47b3e2130213b802212439497',
  '0x914d7fec6aac8cd542e72bca78b30650d45643d7',
];

export const INFRA = new Set([AGENT_ID_REGISTRY, OPEN_FOUR_REGISTRY, MULTICALL3, PCS_ROUTER, PCS_FACTORY]);

export const DEFAULT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed-public.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc-dataseed3.bnbchain.org',
  'https://bsc-dataseed4.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc.publicnode.com',
  'https://bsc-dataseed.nariox.org',
  'https://bsc-dataseed.defibit.io',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://1rpc.io/bnb',
  'https://rpc-bsc.blockmachine.io',
  'https://bsc.meowrpc.com',
  'https://bsc.drpc.org',
  'https://public.1rpc.io/bnb',
  'https://bsc-mainnet.public.blastapi.io',
  'https://binance.llamarpc.com',
  'https://bsc.blockpi.network/v1/rpc/public',
];

/** 鑄造事件無地址 getLogs 專用，不走主掃描池。前兩顆優先。不要放 publicnode（無地址必回 Please specify an address）。 */
export const DEFAULT_LOGS_RPCS = [
  'https://bsc.blockpi.network/v1/rpc/public',
  'https://bsc.drpc.org',
];
export const LOGS_RPC_PRIMARY_COUNT = 2;

/** getLogs 全失敗後的收據後備。獨立於 logs 主線與主掃描池；publicnode 只適合收據或有地址查詢。 */
export const DEFAULT_RECEIPT_RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed1.ninicoin.io',
  'https://bsc-rpc.publicnode.com',
];
export const RECEIPT_RPC_CONCURRENCY = 4;

export const MEME_RUSH_URL = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/rank/list/ai';
export const OPEN_FOUR_PROTOCOL = 2004;
export const AGENT_ID_TOKEN_VERSION = 'openfour.meme.AgentIdExclusive';

export const SEL = {
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  decimals: '0x313ce567',
  symbol: '0x95d89b41',
  name: '0x06fdde03',
  totalSupply: '0x18160ddd',
  owner: '0x8da5cb5b',
  token: '0xfc0c546a',
  ownerOf: '0x6352211e',
  approve: '0x095ea7b3',
  transfer: '0xa9059cbb',
  implementation: '0x5c60da1b',
  getPair: '0xe6a43905',
  getAmountsOut: '0xd06ca61f',
  aggregate3: '0x82ad56cb',
  getEthBalance: '0x4d2301cc',
  registryCore: '0x7ba9413c',
  registryTools: '0xe75dfb3c',
  tokens: '0xe4860339',
  wrappedNative: '0xeb6d3a11',
  zapRouter: '0x2b7b6e08',
  tokenPhase: '0x51d1b100',
  descriptor: '0x303e74df',
  phase: '0xb1c9fe6e',
  totalRaised: '0xc5c4744c',
  remainingForSale: '0x13e4930d',
  isPresetActive: '0x3c3ef33c',
  estimateBuy: '0x43cb095f',
  estimateBuyByBudget: '0x1f8fcbf6',
  estimateSell: '0x92c0e994',
  buy: '0x247d525e',
  buyByBudget: '0x995ee6da',
  sell: '0x8bfc7764',
};

/** 常見免費／低額鑄造選擇子。 */
export const FREE_MINT_CANDIDATES = [
  { name: 'mint()', data: '0x1249c58b' },
  { name: 'freeMint()', data: '0x5b70ea9f' },
  { name: 'claim()', data: '0x4e71d92d' },
  { name: 'publicMint()', data: '0x26092b83' },
  { name: 'mintFree()', data: '0x8ab53447' },
  { name: 'claimFree()', data: '0xf366afc9' },
  { name: 'agentMint()', data: '0x1be3587a' },
  { name: 'commitFreeMint()', data: '0x74d04cfc' },
  { name: 'registerForRewards()', data: '0x9f92d0dd' },
  { name: 'mint(1)', data: '0xa0712d68' + '0'.repeat(63) + '1' },
  { name: 'freeMint(1)', data: '0x7c928fe9' + '0'.repeat(63) + '1' },
  { name: 'claim(1)', data: '0x379607f5' + '0'.repeat(63) + '1' },
];

export const SOLD_SELS = [
  'a2309ff8', 'f4514d2e', '505e05fd', 'cc84efea', '192fc516', '9106d7ba',
  '67153ab4', 'f3f8a4fd', '06ed0717', '9659867e', '4f02c420', '1f21bfbf',
];
export const CAP_SELS = [
  'd8f93498', 'c65b61ca', '3a98ef39', 'b6b6f0c3', 'cce132d1', 'd5abeb01',
  '32cb6b0c', '06517a29', '2163837f', 'aa2d9a02', '76c71ca1', '98f1312e',
  '355274ea', '85e3f997', 'a0e23ebd', 'e985e367', 'f1aee5a2', '0f2cdd6c',
];

export const BAD_SELECTORS = new Set([
  '0xa9059cbb', '0x095ea7b3', '0x23b872dd', '0x42842e0e', '0xb88d4fde',
  '0xa22cb465', '0x39509351', '0xd505accf', '0xf242432a', '0x2eb2c2d6',
]);

export const SOURCE_IDS = ['memeRush', 'newContracts', 'heat', 'mintEvents', 'forceMint'];
export const MINT_KINDS = ['free', 'bnb', 'usdt', 'nft', 'recv', 'bonding', 'replay', 'unknown'];
export const EXEC_MODES = ['notify', 'confirm', 'auto'];
export const STAGES = ['bonding', 'migrating', 'dex', 'unknown'];

export const BLOCK_CODES = {
  EXTRA_APPROVAL: 'EXTRA_APPROVAL',
  UNEXPECTED_DEBIT: 'UNEXPECTED_DEBIT',
  ZERO_NET: 'ZERO_NET',
  REPLAY_FOREIGN_ADDR: 'REPLAY_FOREIGN_ADDR',
  EXCESS_BNB: 'EXCESS_BNB',
  AUTHORITY_CHANGE: 'AUTHORITY_CHANGE',
};

export const EVENT_TYPES = {
  PROJECT_DISCOVERED: 'project.discovered',
  PROJECT_ELIGIBLE: 'project.eligible',
  PROJECT_PROGRESS: 'project.progress',
  MINT_PREVIEW: 'mint.preview',
  MINT_EXECUTED: 'mint.executed',
  MINT_BLOCKED: 'mint.blocked',
  MINT_FAILED: 'mint.failed',
  MINT_PENDING_CONFIRM: 'mint.pendingConfirm',
  SELL_EXECUTED: 'sell.executed',
  SELL_FAILED: 'sell.failed',
  POSITION_MULTIPLE: 'position.multiple',
  POSITION_OPEN: 'position.open',
  SESSION_LOGIN: 'session.login',
  SESSION_DEVMODE: 'session.devmode',
  SESSION_LOW_BNB: 'session.lowBnb',
  CMD_REPLY: 'cmd.reply',
  RISK_DRAIN: 'risk.drain',
  RISK_SERIAL: 'risk.serial',
  MONITOR_STARTED: 'monitor.started',
};
