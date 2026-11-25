import type { Sourced } from '../contracts/completeness';
import type { SolanaMint, SolanaTokenProgram } from '../contracts/solana';

/**
 * What a Solana mint says about its token, decoded from the mint's own bytes
 * (token.ts). Field names follow the node's jsonParsed encoding (agave
 * account-decoder-client-types/src/token.rs), so a reader who knows one knows
 * the other; u64 values are decimal strings, never JSON numbers, since those
 * lose precision above 2^53 (BERN's maximumFee).
 */

/** One of the two fees of a transfer fee config (spl-token-2022 `TransferFee`). */
export type TransferFee = {
  /** The epoch from which this fee applies. */
  epoch: number;
  /** Raw units, as a decimal string: the most one transfer pays. */
  maximumFee: string;
  /** 100 = 1 %. At most 10,000 (`MAX_FEE_BASIS_POINTS`). */
  transferFeeBasisPoints: number;
};

/** `uninitialized` is how the program names an unset state; the node writes it the same way. */
export type DefaultAccountState = 'uninitialized' | 'initialized' | 'frozen';

/**
 * A Token-2022 mint extension, decoded. An address field is `null` when the
 * mint stores zeroes there: nobody holds that role.
 */
export type TokenExtension =
  | {
      extension: 'transferFeeConfig';
      state: {
        transferFeeConfigAuthority: string | null;
        withdrawWithheldAuthority: string | null;
        /** Fees harvested to the mint and not yet withdrawn, raw units. */
        withheldAmount: string;
        olderTransferFee: TransferFee;
        newerTransferFee: TransferFee;
      };
    }
  | { extension: 'mintCloseAuthority'; state: { closeAuthority: string | null } }
  | {
      extension: 'confidentialTransferMint';
      state: {
        authority: string | null;
        autoApproveNewAccounts: boolean;
        /** Base64 of the auditor's ElGamal key; `null` when there is no auditor. */
        auditorElgamalPubkey: string | null;
      };
    }
  | { extension: 'defaultAccountState'; state: { accountState: DefaultAccountState } }
  | { extension: 'nonTransferable'; state: Record<string, never> }
  | {
      extension: 'interestBearingConfig';
      state: {
        rateAuthority: string | null;
        initializationTimestamp: number;
        /** Basis points a year; can be negative. */
        preUpdateAverageRate: number;
        lastUpdateTimestamp: number;
        currentRate: number;
      };
    }
  | { extension: 'permanentDelegate'; state: { delegate: string | null } }
  | { extension: 'transferHook'; state: { authority: string | null; programId: string | null } }
  | {
      extension: 'confidentialTransferFeeConfig';
      state: {
        authority: string | null;
        /** Base64, as the node writes it. */
        withdrawWithheldAuthorityElgamalPubkey: string;
        harvestToMintEnabled: boolean;
        /** Base64 of the encrypted amount. */
        withheldAmount: string;
      };
    }
  | {
      extension: 'metadataPointer';
      state: { authority: string | null; metadataAddress: string | null };
    }
  | {
      extension: 'tokenMetadata';
      state: {
        updateAuthority: string | null;
        mint: string;
        name: string;
        symbol: string;
        uri: string;
        additionalMetadata: [string, string][];
      };
    }
  | { extension: 'groupPointer'; state: { authority: string | null; groupAddress: string | null } }
  | {
      extension: 'tokenGroup';
      state: { updateAuthority: string | null; mint: string; size: string; maxSize: string };
    }
  | {
      extension: 'groupMemberPointer';
      state: { authority: string | null; memberAddress: string | null };
    }
  | { extension: 'tokenGroupMember'; state: { mint: string; group: string; memberNumber: string } }
  | {
      extension: 'confidentialMintBurn';
      /** Base64 ciphertexts and key, as the node writes them. */
      state: {
        confidentialSupply: string;
        decryptableSupply: string;
        supplyElgamalPubkey: string;
        pendingBurn: string;
      };
    }
  | {
      extension: 'scaledUiAmountConfig';
      state: {
        authority: string | null;
        multiplier: number;
        /** Unix seconds from which `newMultiplier` replaces `multiplier`. */
        newMultiplierEffectiveTimestamp: number;
        newMultiplier: number;
      };
    }
  | { extension: 'pausableConfig'; state: { authority: string | null; paused: boolean } }
  | { extension: 'permissionedBurnConfig'; state: { authority: string | null } }
  /**
   * An extension SEAL does not decode: a type number it does not know, or a
   * known one whose length is not the one its layout gives. What it allows is
   * unknown, and the read is partial.
   */
  | { extension: 'unknown'; state: { type: number; length: number; reason: string } };

export type TokenExtensionName = TokenExtension['extension'];

/** The token's name, symbol and link, and who can still change them. */
export type TokenMetadataInfo = {
  /** Where it was read: the Token-2022 `tokenMetadata` extension, or a Metaplex metadata account. */
  source: 'tokenMetadata' | 'metaplex';
  /** The account it was read from: the mint itself, or another account. */
  account: string;
  name: string;
  symbol: string;
  uri: string;
  /**
   * Who can change name, symbol and uri. Metaplex always stores one, even when
   * `isMutable` is false; Token-2022 stores none when nobody can.
   */
  updateAuthority: string | null;
  /** Whether name, symbol and uri can still change. */
  isMutable: boolean;
  /** Token-2022 only: extra key/value pairs; empty for Metaplex. */
  additionalMetadata: [string, string][];
  /**
   * The mint this metadata names, when it is not the token's own: the
   * token's metadata pointer names another mint's metadata, shared by
   * several tokens (every Seeker Genesis Token shows its group's).
   */
  otherMint?: string;
};

/**
 * A mint read on Solana: the contract's `SolanaMint` with each extension
 * decoded, plus the metadata. Assignable to `SolanaMint`.
 */
export type SolanaToken = Omit<SolanaMint, 'extensions'> & {
  program: SolanaTokenProgram;
  extensions: TokenExtension[];
  metadata: TokenMetadataInfo | null;
  /** The epoch when read, when a transfer fee needed it to tell which fee applies; else `null`. */
  epoch: number | null;
  /** When it was read (ISO): the clock a scaled amount's switch time is compared to. */
  readAt: string;
  /** What could not be read or decoded, in plain words; empty when the read is complete. */
  gaps: string[];
};

/**
 * `data` is `null` when the address holds no token mint (completeness
 * `full`, the note says what is there) or when the mint could not be read
 * (completeness `unavailable`, the note says why).
 */
export type TokenRead = Sourced<SolanaToken | null>;

/** The powers a mint can keep over its token and its holders. */
export type TokenPowerKind =
  | 'mint'
  | 'freeze'
  | 'permanent-delegate'
  | 'pause'
  | 'transfer-hook'
  | 'transfer-fee'
  | 'transfer-fee-change'
  | 'default-account-state'
  | 'non-transferable'
  | 'close-mint'
  | 'interest-rate'
  | 'ui-multiplier'
  | 'confidential-transfers'
  | 'confidential-mint-burn'
  | 'permissioned-burn'
  | 'metadata-update'
  | 'metadata-pointer'
  | 'unknown';

export type TokenPower = {
  power: TokenPowerKind;
  /**
   * `held`: someone holds it today. `none`: the role exists but nobody holds
   * it (revoked, or never set), or the setting does nothing. `fixed`: a rule
   * in force that nobody can change. `unknown`: SEAL could not read it.
   */
  status: 'held' | 'none' | 'fixed' | 'unknown';
  /** Who holds it; `null` when nobody does, or for a rule nobody holds. */
  holder: string | null;
  /** One plain sentence, facts only. */
  sentence: string;
  /** Where it was read: `mint`, an extension name, or `metaplex`. */
  from: 'mint' | 'metaplex' | TokenExtensionName;
};
