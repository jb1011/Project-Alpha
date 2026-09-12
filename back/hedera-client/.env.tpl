# Template for `op run --env-file=.env.tpl -- <command>`. Secret values are 1Password
# references and are resolved into the child process only; nothing here is a secret.
# Vault: "Novi Corpus". Testnet only.

# Guardian of the float account. Funds the agent's EVM alias and signs the key-list
# update and the revocation. Item: Hedera Testnet Treasury.
TREASURY_ACCOUNT_ID=op://Novi Corpus/Hedera Testnet Treasury/account_id
TREASURY_PRIVATE_KEY=op://Novi Corpus/Hedera Testnet Treasury/private_key_hex

# The customer's agent key. Never leaves this process; the Novi Corpus server never sees it.
# `provision` writes these fields when it generates a new key. Item: Hedera Spike Agent Key.
AGENT_ACCOUNT_ID=op://Novi Corpus/Hedera Spike Agent Key/account_id
AGENT_PRIVATE_KEY=op://Novi Corpus/Hedera Spike Agent Key/private_key_hex

# Novi Corpus MCP endpoint. Local backend for task 8, prod for the demo (D28):
# https://www.novicorpus.com/backend/mcp
NOVI_MCP_URL=http://127.0.0.1:8787/mcp
# Field `local` is the key task 8 mints against the local backend; task 16 mints `prod`
# into the same item. Item: Novi Corpus Demo API Key.
NOVI_API_KEY=op://Novi Corpus/Novi Corpus Demo API Key/local

# The entity whose policy is checked and whose ledger the payment lands in. The seeded
# FormationE2E_1 row's id for task 8; HederaDemo_1's for the demo. Public value, fill in.
NOVI_ENTITY_ID=0x6AB681DbFa81CA0D4acec965bDEd3A17292Ac142:FormationE2E_1
# HederaDemo_1's own HCS-11 profile URL, set as the float account's memo (task 12).
# Public value, fill in when task 12 lands. Shape: https://www.novicorpus.com/backend/metadata/<publicId>/profile
NOVI_PROFILE_URL=https://www.novicorpus.com/backend/metadata/9f8003f5-4c70-435a-9980-9a54625691b7/profile

HEDERA_MIRROR_URL=https://testnet.mirrornode.hedera.com
USDC_TOKEN_ID=0.0.429274
