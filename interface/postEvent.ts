export interface _postData {
    length: number;
    type: string;
    contents: string;
    name: string;
}

export interface postEvent {
    queryString: string;
    parameter: { name: string, n: string };
    parameters: { name: string, n: string[] };
    contentLength: number;
    postData: _postData;
}