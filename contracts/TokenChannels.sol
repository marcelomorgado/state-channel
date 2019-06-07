pragma solidity 0.5.8;

import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

// TODO
//
// Challenge
// ChannelState
// Safety review
//
contract TokenChannels {
    using SafeMath for uint256;
    using ECDSA for bytes32;

    enum ChannelStatus {OPEN, CLOSING, CLOSED}

    struct Channel {
        bytes32 channelId;
        address tokenAddress;
        address partyAddress;
        address counterPartyAddress;
        uint256 partyBalance;
        uint256 counterPartyBalance;
        uint nonce;
        uint closeTime;
        uint challengePeriod;
        ChannelStatus status;
    }

    mapping(bytes32 => Channel) public channels;

    //
    // Events
    //
    event ChannelOpened(bytes32 channelId);
    event CounterPartyJoined(bytes32 channelId);
    event ChannelClosed(bytes32 channelId);
    event ChannelChallenged(bytes32 channelId);
    event ChannelFinalized(bytes32 channelId);

    //
    // Modifiers
    //
    modifier validChannel(bytes32 id) {
        require(channels[id].channelId != 0, "No channel with that channelId exists");
        _;
    }

    modifier onlyParties(bytes32 id) {
        require(
            msg.sender == channels[id].partyAddress || msg.sender == channels[id].counterPartyAddress,
            "You are not a participant in this channel"
        );
        _;
    }

    modifier isOpenned(bytes32 id) {
        require(channels[id].status == ChannelStatus.OPEN, "The channel should be opened.");
        _;
    }

    modifier notClosed(bytes32 id) {
        require(
            channels[id].status != ChannelStatus.CLOSED,
            "The channel shouldn't not be closed."
        );
        _;
    }

    //
    // Public functions
    //

    /**
   * Open a new channel. That contract should be approved by the sender to transfer on his behalf
   *
   * @param tokenAddress        Address of the token contract
   * @param counterPartyAddress Account address of the other party
   * @param amount              Number of tokens to deposit
   * @param challengePeriod     Optional challenge period for either party to close the channel
   */
    function open(
        address tokenAddress,
        address counterPartyAddress,
        uint256 amount,
        uint challengePeriod
    ) public {
        address partyAddress = msg.sender;

        require(partyAddress != counterPartyAddress, "You can't create a channel with yourself");
        require(amount != 0, "You can't create a payment channel without tokens");

        bytes32 channelId = keccak256(
            abi.encodePacked(tokenAddress, partyAddress, counterPartyAddress, block.number)
        );

        // TODO: Test if channelID already exists

        Channel memory channel = Channel(
            channelId,
            tokenAddress,
            partyAddress,
            counterPartyAddress,
            amount, // partyBalance
            0, // counterPartyBalance
            0, // nonce
            0, // closeTime
            challengePeriod,
            ChannelStatus.OPEN // status
        );

        ERC20 token = ERC20(tokenAddress);
        require(
            token.transferFrom(partyAddress, address(this), amount),
            "Token transfer with error"
        );

        channels[channelId] = channel;

        emit ChannelOpened(channelId);
    }

    /**
   * Join to an existent channel. That contract should be approved by the sender to transfer on his behalf
   *
   * @param channelId   Channel ID
   * @param amount      Number of tokens to deposit (can be zero)
   */
    function join(bytes32 channelId, uint256 amount)
        public
        validChannel(channelId)
        isOpenned(channelId)
    {
        address counterPartyAddress = msg.sender;

        Channel storage channel = channels[channelId];

        require(
            channel.counterPartyAddress == counterPartyAddress,
            "The channel creator did'nt specify you as the counter party"
        );

        require(amount >= 0, "Incorrect amount");

        if (amount > 0) {
            ERC20 token = ERC20(channel.tokenAddress);
            require(
                token.transferFrom(counterPartyAddress, address(this), amount),
                "Token transfer with error"
            );
        }

        channel.counterPartyBalance = amount;

        emit CounterPartyJoined(channelId);
    }

    /**
   * Close a channel
   *
   * @param channelId               Channel ID
   * @param nonce                   Sequence number
   * @param partyBalance            The final balance of the party
   * @param counterPartyBalance     The final balance of the counter party
   * @param partySignature          Last state of the channel signed by the party
   * @param counterPartySignature   Last state of the channel signed by the counter party
   */
    function close(
        bytes32 channelId,
        uint nonce,
        uint256 partyBalance,
        uint256 counterPartyBalance,
        bytes memory partySignature,
        bytes memory counterPartySignature
    ) public onlyParties(channelId) validChannel(channelId) notClosed(channelId) {
        Channel memory channel = channels[channelId];

        bool channelHasNoChallengePeriod = channel.challengePeriod == 0;
        bool challengeIsOver = channel.closeTime + channel.challengePeriod > now;
        bool isChallange = channel.status == ChannelStatus.CLOSING;

        require(channelHasNoChallengePeriod || !challengeIsOver);

        verifyReceiptSignatures(
            channelId,
            nonce,
            partyBalance,
            counterPartyBalance,
            partySignature,
            counterPartySignature
        );

        if (channelHasNoChallengePeriod || challengeIsOver) {
            updateReceipt(channelId, nonce, partyBalance, counterPartyBalance);
            distributeFunds(channelId);
            return;
        }

        if(isChallange) {
            require(nonce > channel.nonce, "The nonce should be greater than the last");
            updateReceipt(channelId, nonce, partyBalance, counterPartyBalance);
            emit ChannelChallenged(channelId);
        } else {
            updateReceipt(channelId, nonce, partyBalance, counterPartyBalance);
            emit ChannelClosed(channelId);
        }
    }

    //
    // Internal functions
    //

    function verifyReceiptSignatures(
        bytes32 channelId,
        uint nonce,
        uint256 partyBalance,
        uint256 counterPartyBalance,
        bytes memory partySignature,
        bytes memory counterPartySignature
    ) internal {
        Channel memory channel = channels[channelId];

        bytes32 stateHash = keccak256(
            abi.encodePacked(channelId, partyBalance, counterPartyBalance, nonce)
        );

        require(
            ecverify(stateHash, partySignature, channel.partyAddress),
            "The partySignature is invalid"
        );
        require(
            ecverify(stateHash, counterPartySignature, channel.counterPartyAddress),
            "The counterPartySignature is invalid"
        );
    }

    function updateReceipt(
        bytes32 channelId,
        uint nonce,
        uint256 partyBalance,
        uint256 counterPartyBalance
    ) internal {
        Channel storage channel = channels[channelId];

        require(
            partyBalance.add(counterPartyBalance) == channel.partyBalance.add(
                channel.counterPartyBalance
            ),
            "The law of conservation of total balances was not respected"
        );

        channel.nonce = nonce;
        channel.partyBalance = partyBalance;
        channel.counterPartyBalance = counterPartyBalance;
        if (channel.closeTime == 0) channel.closeTime = now;
        channel.status = ChannelStatus.CLOSING;
    }

    /**
   * Transfer tokens to channel participants
   *
   * @param channelId   Channel ID
   */
    function distributeFunds(bytes32 channelId) internal notClosed(channelId) {
        Channel storage channel = channels[channelId];
        channel.status = ChannelStatus.CLOSED;

        ERC20 token = ERC20(channel.tokenAddress);

        if (channel.partyBalance > 0) {
            require(
                token.transfer(channel.partyAddress, channel.partyBalance),
                "Token transfer to the party failed"
            );
        }

        if (channel.counterPartyBalance > 0) {
            require(
                token.transfer(channel.counterPartyAddress, channel.counterPartyBalance),
                "Token transfer to the counter party failed"
            );
        }

        emit ChannelFinalized(channelId);
    }

    /**
   * Check if a hash was signed by an address
   * Note: That function was tested using signatures by web3.eth.sign()
   *
   * @param hash        Hash data
   * @param signature   Signature to check
   * @param signer      Signer to check
   */
    function ecverify(bytes32 hash, bytes memory signature, address signer)
        internal
        pure
        returns (bool b)
    {
        bytes32 ethHash = hash.toEthSignedMessageHash();
        return ethHash.recover(signature) == signer;
    }

}
