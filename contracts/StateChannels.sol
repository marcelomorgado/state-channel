pragma solidity 0.5.8;

contract StateChannels {
    // the data structure for the channel
    struct Channel {
        bytes32 channelId;
        address address0;
        address address1;
        uint balance0;
        uint balance1;
        uint sequenceNumber;
    }

    // channels by Id
    mapping(bytes32 => Channel) channels;

    event ChannelOpened(bytes32 channelId);

    // TODO: Generate channelId
    function open(bytes32 channelId, address address1, uint value) public payable {
        require(
            channels[channelId].channelId != channelId,
            "channel with that channelId already exists"
        );
        require(msg.sender != address1, "you cant create a channel with yourself");
        require(value != 0, "you can't create a payment channel with no money");
        require(msg.value == value, "incorrect funds");

        Channel memory channel = Channel(
            channelId,
            msg.sender, // address0
            address1, // address1
            msg.value, // balance0
            0, // balance1
            0 // sequence number
        );

        channels[channelId] = channel;

        emit ChannelOpened(channelId);
    }

    function join(bytes32 channelId) public payable {
        require(channels[channelId].channelId != 0, "no channel with that channelId exists");
        require(
            channels[channelId].address1 == msg.sender,
            "the channel creator did not specify you as the second participant"
        );
        require(msg.value != 0, "incorrect funds");

        channels[channelId].balance1 = msg.value;
    }
}
