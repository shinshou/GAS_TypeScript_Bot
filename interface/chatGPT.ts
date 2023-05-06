export interface gptResponse {
    id: string;
    object: string;
    created: number;
    model: string;
    usage: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
    choices: [{
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
        index: number;
    }]
}

export interface embeddingResponse {
    object: string;
    model: string;
    usage: {
        prompt_tokens: number;
        total_tokens: number;
    };
    data: [{
        embedding: number[];
        object: string;
        index: number;
    }]
}

export interface contexts {
    text: string;
    vector: number[];
}
