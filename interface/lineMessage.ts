interface messageContents {
    id: string;
    type: string;
    text: string;
}

interface eventJson {
    replyToken: string;
    type: string;
    mode: string;
    timestamp: number;
    source: {
        type: string;
        groupId: string;
        userId: string;
    };
    message: messageContents;
}

export interface jsonMessage {
    destination: string;
    events: eventJson[];
}