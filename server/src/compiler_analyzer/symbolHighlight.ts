import {TokenObject} from '../compiler_tokenizer/tokenObject';
import {TokenHighlight} from '../core/highlight';
import {NodeName} from '../compiler_parser/nodeObject';
import {SymbolObject} from './symbolObject';

/**
 * The parser colours identifiers from syntax alone, so a member field reads as a plain variable and a method as a
 * free function. Once the analyzer knows which symbol a token names, recolour it from that symbol.
 */
export function highlightTokenFromSymbol(token: TokenObject, symbol: SymbolObject) {
    if (token.isVirtual() || token.isReservedToken()) {
        return;
    }

    const highlight = highlightOfSymbol(symbol);
    if (highlight !== undefined) {
        token.setHighlight(highlight);
    }
}

function highlightOfSymbol(symbol: SymbolObject): TokenHighlight | undefined {
    if (symbol.isType()) {
        if (symbol.isTemplateParameterType) return TokenHighlight.TypeParameter;
        switch (symbol.linkedNode?.nodeName) {
        case NodeName.Class:
            return TokenHighlight.Class;
        case NodeName.Interface:
            return TokenHighlight.Interface;
        case NodeName.Enum:
            return TokenHighlight.Enum;
        default:
            // Primitive types are keywords and keep their keyword colour.
            return undefined;
        }
    }

    if (symbol.isFunction()) {
        // A constructor call such as FVector(0, 0, 0) reads as its type, as in C++.
        if (symbol.scopePath.at(-1) === symbol.identifierText) return TokenHighlight.Class;
        return symbol.isInstanceMember ? TokenHighlight.Method : TokenHighlight.Function;
    }

    if (symbol.isVariable()) {
        if (symbol.isInstanceMember) return TokenHighlight.Property;
        // The declaration already says parameter, enum member or variable.
        const declared = symbol.identifierToken.highlight.tokenHighlight;
        if (declared === TokenHighlight.Parameter || declared === TokenHighlight.EnumMember) return declared;
        return TokenHighlight.Variable;
    }

    return undefined;
}
