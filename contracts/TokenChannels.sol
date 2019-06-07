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

    //enum ChannelState { Open, Closing, Closed }

    struct Channel {
        bytes32 channelId;
        address tokenAddress;
        address partyAddress;
        address counterPartyAddress;
        uint256 partyBalance;
        uint256 counterPartyBalance;
        uint nonce;
    }

    mapping(bytes32 => Channel) public channels;

    //
    // Events
    //
    event ChannelOpened(bytes32 channelId);
    event CounterPartyJoined(bytes32 channelId);
    event ChannelClosed(bytes32 channelId);

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

    //
    // Public functions
    //

    /**
   * Open a new channel. That contract should be approved by the sender to transfer on his behalf
   *
   * @param tokenAddress        Address of the token contract
   * @param counterPartyAddress Account address of the other party
   * @param amount              Number of tokens to deposit
   */
    function open(address tokenAddress, address counterPartyAddress, uint256 amount) public {
        address partyAddress = msg.sender;

        require(partyAddress != counterPartyAddress, "You can't create a channel with yourself");
        require(amount != 0, "You can't create a payment channel without tokens");

        bytes32 channelId = keccak256(
            abi.encodePacked(tokenAddress, partyAddress, counterPartyAddress, block.number)
        );

        Channel memory channel = Channel(
            channelId,
            tokenAddress,
            partyAddress,
            counterPartyAddress,
            amount, // partyBalance
            0, // counterPartyBalance
            0 // nonce
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
    function join(bytes32 channelId, uint256 amount) public validChannel(channelId) {
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
    ) public onlyParties(channelId) validChannel(channelId) {
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
        //require(nonce > channel.nonce, "sequence number too low");

        require(
            partyBalance.add(counterPartyBalance) == channel.partyBalance.add(channel.counterPartyBalance),
            "The law of conservation of total balances was not respected"
        );

        delete channels[channelId];

        ERC20 token = ERC20(channel.tokenAddress);
        require(
            token.transfer(channel.partyAddress, partyBalance),
            "Token transfer to the party failed"
        );
        require(
            token.transfer(channel.counterPartyAddress, counterPartyBalance),
            "Token transfer to the counter party failed"
        );

        emit ChannelClosed(channelId);
    }

    //
    // Internal functions
    //

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
