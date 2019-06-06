pragma solidity 0.5.8;

import "openzeppelin-solidity/contracts/cryptography/ECDSA.sol";
import "openzeppelin-solidity/contracts/math/SafeMath.sol";
import "openzeppelin-solidity/contracts/token/ERC20/ERC20.sol";

// TODO
//
// Rename vars
// Use SafeMath
// Use modifers
// Challenge
// Offline cases (periods)
// ChannelState
// Great comments
// Review error messages
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
        uint partyBalance;
        uint counterPartyBalance;
        uint nonce;
    }

    // channels by Id
    mapping(bytes32 => Channel) channels;

    event ChannelOpened(bytes32 channelId);
    event CounterPartyJoined(bytes32 channelId);
    event ChannelClosed(bytes32 channelId);

    modifier validChannel(bytes32 id) {
        require(channels[id].channelId != 0, "no channel with that channelId exists");
        _;
    }

    modifier onlyParties(bytes32 id) {
        require(
            msg.sender == channels[id].partyAddress || msg.sender == channels[id].counterPartyAddress,
            "you are not a participant in this channel"
        );
        _;
    }

    function open(address tokenAddress, address counterPartyAddress, uint256 amount) public {
        address partyAddress = msg.sender;

        require(partyAddress != counterPartyAddress, "you cant create a channel with yourself");
        require(amount != 0, "you can't create a payment channel with no money");

        // Note: block.timestamp isn't a strong source of entropy but it's safe enough for that use case
        bytes32 channelId = keccak256(
            abi.encodePacked(partyAddress, counterPartyAddress, block.timestamp)
        );

        Channel memory channel = Channel(
            channelId,
            tokenAddress,
            partyAddress,
            counterPartyAddress,
            amount, // partyBalance
            0, // counterPartyBalance
            0 // sequence number
        );

        ERC20 token = ERC20(tokenAddress);
        require(token.transferFrom(partyAddress, address(this), amount), "incorrect funds");

        channels[channelId] = channel;

        emit ChannelOpened(channelId);
    }

    function join(bytes32 channelId, uint256 amount) public validChannel(channelId) {
        address counterPartyAddress = msg.sender;

        Channel storage channel = channels[channelId];

        require(
            channel.counterPartyAddress == counterPartyAddress,
            "the channel creator did not specify you as the second participant"
        );
        require(amount != 0, "incorrect funds");

        ERC20 token = ERC20(channel.tokenAddress);
        require(token.transferFrom(counterPartyAddress, address(this), amount), "incorrect funds");

        channel.counterPartyBalance = amount;

        emit CounterPartyJoined(channelId);
    }

    function close(
        bytes32 channelId,
        uint nonce,
        uint partyBalance,
        uint counterPartyBalance,
        bytes memory partySignature,
        bytes memory counterPartySignature
    ) public onlyParties(channelId) validChannel(channelId) {
        Channel memory channel = channels[channelId];

        bytes32 stateHash = keccak256(
            abi.encodePacked(channelId, partyBalance, counterPartyBalance, nonce)
        );

        require(
            ecverify(stateHash, partySignature, channel.partyAddress),
            "partySignature invalid"
        );
        require(
            ecverify(stateHash, counterPartySignature, channel.counterPartyAddress),
            "counterPartySignature invalid"
        );
        //require(nonce > channel.nonce, "sequence number too low");

        require(
            (partyBalance + counterPartyBalance) == (channel.partyBalance + channel.counterPartyBalance),
            "the law of conservation of total balances was not respected"
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

    function ecverify(bytes32 hash, bytes memory sig, address signer)
        internal
        pure
        returns (bool b)
    {
        bytes32 ethHash = hash.toEthSignedMessageHash();
        return ethHash.recover(sig) == signer;
    }

}
