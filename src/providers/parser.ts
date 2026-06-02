import Parser from "web-tree-sitter";
import {
    nestedPrompt,
    privatePrompt,
    dependencyPrompt,
    conditionalPrompt,
    reductionPrompt,
    iterPrompt,
    updatePrompt
} from "../service/common"

interface tab {
    [key: string]: any;
}

interface Status {
    nested: boolean;
    private: boolean;
    reduction: boolean;
    update: boolean;
    conditional: boolean;
    indexx: string;
    errmsg: string;
}
 
let status: Status = {
    nested: false,
    private: false,
    reduction: false,
    update: false,
    conditional: false,
    indexx: "",
    errmsg: "This loop is not parallelizable!\n"
};

let experiences = ""
let par = false;

let assigned: tab = {
    name: [],
    index: [],
    depth: []
}

let queried: tab = {
    name: [],
    index: [],
    depth: []
}

let reduction_count: tab = {
    name: [],
    index: [],
    depth: []
}

let no_reduction: tab = {
    name: [],
    index: [],
    depth: []
}

export function check(tree: any): string {
    init();
    let text_selection = tree.rootNode.text;
    if (text_selection.indexOf("printf") !== -1 || text_selection.indexOf("scanf") !== -1) {
        err("IO!")
        return 'false'
    }

    let head = tree.rootNode.namedChild(0);
    status.indexx = head.namedChild(2).namedChild(0).text;
    if (head.namedChild(3).grammarType === "compound_statement") {
        if (compound_handle(head.namedChild(3), 1)) {
            if (!status.reduction && reduction_count["name"].length > 0) {
                status.reduction = true;
                experiences = experiences + reductionPrompt;
            }
            if (sub_check()) {
                err("Dependency!");
                return 'false';
            }
            if (experiences === "") {
                experiences = "No experience matched, maybe you should just apply \"#pragma omp parallel for\" to the loop.";
            }
            test();
            return experiences;
            // if (par) {
            //     return experiences;
            // }
            // else {
            //     err("Assignment only!");
            //     return 'false';
            // }
        }
        else {
            test();
            return 'false';
        }
    }
    else {
        if (statement_handle(head.namedChild(3), 1)) {
            if (!status.reduction && reduction_count["name"].length > 0) {
                status.reduction = true;
                experiences = experiences + reductionPrompt;
            }
            if (sub_check()) {
                err("Dependency!");
                return 'false';
            }
            if (experiences === "") {
                experiences = "No experience matched, maybe you should just apply \"#pragma omp parallel for\" to the loop.";
            }
            test();
            return experiences;
            // if (par) {
            //     return experiences;
            // }
            // else {
            //     err("Assignment only!");
            //     return 'false';
            // }
        }
        else {
            test();
            return 'false';
        }
    }
}

function compound_handle(node: any, depth: number): boolean {
    let flag = true;
    for (let i = 0; i < node.namedChildCount; i++) {
        let tmp = node.namedChild(i);
        let name = tmp.grammarType;
        if (name === "expression_statement") {
            if (tmp.namedChild(0).grammarType === "assignment_expression") {
                if (tmp.namedChild(0).namedChild(0).grammarType === "identifier" && (tmp.text.indexOf("+=") !== -1 || tmp.text.indexOf("-=") !== -1 || tmp.text.indexOf("*=") !== -1 || tmp.text.indexOf("/=") !== -1)) {
                    status.reduction = true;
                    experiences = experiences + reductionPrompt;
                }
                flag = assign_handle(tmp.namedChild(0), depth);
            }
            else if (tmp.namedChild(0).grammarType === "conditional_expression") {
                flag = condition_handle(tmp.namedChild(0), depth)
            }
            else if (tmp.namedChild(0).grammarType === "call_expression") {
                flag = call_handle(tmp.namedChild(0), depth)
            }
            else if (tmp.namedChild(0).grammarType === "update_expression") {
                flag = PnR(tmp.namedChild(0).namedChild(0).text, tmp.namedChild(0).namedChild(0).text, "null", -1)
                create(assigned, tmp.namedChild(0).namedChild(0).text, "null", depth)
                create(queried, tmp.namedChild(0).namedChild(0).text, "null", depth)
                if (!status.update) {
                    status.update = true
                    experiences = experiences + updatePrompt;
                }
            }
            else {
                // 对于无法识别的表达式类型，不报错，继续处理
                // 这样可以支持函数调用等其他语句
                console.log("Unknown expression type:", tmp.namedChild(0).grammarType);
                // 如果是函数调用，尝试处理
                if (tmp.text.includes("(") && tmp.text.includes(")")) {
                    par = true;
                }
            }
        }
        else if (name === "for_statement") {
            if (tmp.namedChild(3).grammarType == "compound_statement") {
                flag = compound_handle(tmp.namedChild(3), depth + 1);
            }
            else {
                flag = statement_handle(tmp.namedChild(3), depth + 1);
            }
            if (!status.nested) {
                status.nested = true
                experiences = nestedPrompt + experiences
            }
        }
        else if (name === "if_statement") {
            flag = if_handle(tmp, depth)
        }
        else if (name === "compound_statement") {
            flag = compound_handle(tmp, depth)
        }
        else if (name === "switch_statement") {
            // flag = switch_handle(tmp, depth)
        }
        else if (name === "declaration") {
            flag = dec_handle(tmp, depth)
        }
        else {
            err("Statement not found!");
            err(name);
            return false;
        }
        if (!flag) {
            break;
        }
    }
    return flag;
}

function statement_handle(node: any, depth: number): boolean {
    let flag = true;
    let tmp = node;
    let name = tmp.grammarType;
    if (name === "expression_statement") {
        if (tmp.namedChild(0).grammarType === "assignment_expression") {
            if (tmp.namedChild(0).namedChild(0).grammarType === "identifier" && (tmp.text.indexOf("+=") !== -1 || tmp.text.indexOf("-=") !== -1 || tmp.text.indexOf("*=") !== -1 || tmp.text.indexOf("/=") !== -1)) {
                status.reduction = true;
                experiences = experiences + reductionPrompt;
            }
            flag = assign_handle(tmp.namedChild(0), depth);
        }
        else if (tmp.namedChild(0).grammarType === "conditional_expression") {
            flag = condition_handle(tmp.namedChild(0), depth)
        }
        else if (tmp.namedChild(0).grammarType === "call_expression") {
            flag = call_handle(tmp.namedChild(0), depth)
        }
        else if (tmp.namedChild(0).grammarType === "update_expression") {
            flag = PnR(tmp.namedChild(0).namedChild(0).text, tmp.namedChild(0).namedChild(0).text, "null", -1)
            create(assigned, tmp.namedChild(0).namedChild(0).text, "null", depth)
            create(queried, tmp.namedChild(0).namedChild(0).text, "null", depth)
            if (!status.update) {
                status.update = true
                experiences = experiences + updatePrompt;
            }
        }
        else {
            err("Expression not found!");
            err(tmp.namedChild(0).grammarType);
            return false;
        }
    }
    else if (name === "for_statement") {
        if (tmp.namedChild(3).grammarType == "compound_statement") {
            flag = compound_handle(tmp.namedChild(3), depth + 1);
        }
        else {
            flag = statement_handle(tmp.namedChild(3), depth + 1);
        }
        if (!status.nested) {
            status.nested = true
            experiences = nestedPrompt + experiences
        }
    }
    else if (name === "if_statement") {
        flag = if_handle(tmp, depth)
    }
    else if (name === "compound_statement") {
        flag = compound_handle(tmp, depth)
    }
    else if (name === "switch_statement") {
        // flag = switch_handle(tmp, depth)
    }
    else if (name === "declaration") {
        flag = dec_handle(tmp, depth)
    }
    else {
        err("Statement not found!");
        err(name);
        return false;
    }
    return flag;
}

function dec_handle(node: any, depth: number): boolean {
    for (let i = 0; i < node.namedChildCount; i++) {
        if (node.namedChild(i).grammarType === "init_declarator") {
            if (node.namedChild(i).namedChild(0).grammarType !== "identifier") {
                err("Declearation error!");
                return false;
            }
            else {
                create(assigned, node.namedChild(i).namedChild(0).text, "null", -1);
            }
        }
    }
    return true;
}

function assign_handle(node: any, depth: number): boolean {
    let l_node = node.namedChild(0);
    let r_node = node.namedChild(1);
    let flag1 = true;
    let flag2 = true;

    while (l_node.grammarType === "unary_expression" || l_node.grammarType === "parenthesized_expression" || l_node.grammarType === "cast_expression" || l_node.grammarType === "field_expression") {
        if (l_node.grammarType === "cast_expression") {
            l_node = l_node.namedChild(1);
        }
        else {
            l_node = l_node.namedChild(0);
        }
    }

    while (r_node.grammarType === "unary_expression" || r_node.grammarType === "parenthesized_expression" || r_node.grammarType === "cast_expression" || r_node.grammarType === "field_expression") {
        if (r_node.grammarType === "cast_expression") {
            r_node = r_node.namedChild(1);
        }
        else {
            r_node = r_node.namedChild(0);
        }
    }

    if (l_node.grammarType === "identifier") {
        flag1 = PnR(l_node.text, r_node.text, "null", -1);
        create(assigned, l_node.text, "null", depth);
    }
    else if (l_node.grammarType === "subscript_expression") {
        let sub_table: any[] = [];
        get_sub(l_node, sub_table)
        for (let i = 1; i < sub_table.length; i++) {
            if (sub_table[i].text.indexOf("/") !== -1) {
                err("Divide!")
                return false
            }

            if (changed(sub_table[i], 1)) {
                err("Indirect access!")
                return false
            }
        }

        flag1 = subscript_handle(l_node, depth, assigned)
    }
    else {
        err("Assignment type not found!");
        err(l_node.grammarType);
        return false;
    }

    if (r_node.grammarType === "cast_expression") {
        r_node = r_node.namedChild(1);
    }
    if (r_node.grammarType === "unary_expression") {
        r_node = r_node.namedChild(0);
    }

    if (r_node.grammarType === "identifier") {
        create(queried, r_node.text, "null", depth);
    }
    else if (r_node.grammarType == "subscript_expression") {
        flag2 = subscript_handle(r_node, depth, queried)
    }
    else if (r_node.grammarType == "binary_expression") {
        flag2 = binary_handle(r_node, depth)
    }
    else if (r_node.grammarType == "number_literal") {
        // pass
    }
    else if (r_node.grammarType == "true") {
        // pass
    }
    else if (r_node.grammarType == "false") {
        // pass
    }
    else if (r_node.grammarType == "string_literal") {
        // pass
    }
    else if (r_node.grammarType == "char_literal") {
        // pass
    }
    else if (r_node.grammarType == "conditional_expression") {
        flag2 = condition_handle(r_node, depth)
    }
    else if (r_node.grammarType == "call_expression") {
        flag2 = call_handle(r_node, depth)
    }
    else {
        err("Assignment type not found!");
        err(r_node.grammarType);
        return false;
    }
    return flag1 && flag2;
}

function get_sub(node: any, sub_table: any[]) {
    let l_node = node.namedChild(0);
    let r_node = node.namedChild(1);
    if (l_node.grammarType === "subscript_expression") {
        get_sub(l_node, sub_table);
    }
    else {
        sub_table[sub_table.length] = l_node;
    }
    sub_table[sub_table.length] = r_node;
}

function subscript_handle(node: any, depth: number, table: tab): boolean {
    let flag = true;
    let sub_table: any[] = [];

    get_sub(node, sub_table);
    //sub_table[1]
    create(table, sub_table[0].text, sub_table, depth);
    for (let i = 1; i < sub_table.length; i++) {
        if (sub_table[i].grammarType === "identifier") {
            create(queried, sub_table[i].text, "null", depth);
        }
        else if (sub_table[i].grammarType === "subscript_expression") {
            flag = subscript_handle(sub_table[i], depth, queried)
        }
        else if (sub_table[i].grammarType === "binary_expression") {
            flag = binary_handle(sub_table[i], depth)
        }
        else if (sub_table[i].grammarType === "number_literal") {
            // pass
        }
        else {
            err("Subscript type not found!");
            err(sub_table[i].grammarType);
            return false;
        }
        if (!flag) {
            break;
        }
    }
    return flag;
}

function binary_handle(node: any, depth: number): boolean {
    par = true;
    let flag1 = true;
    let flag2 = true;
    let l_node = node.namedChild(0);
    let r_node = node.namedChild(1);

    while (l_node.grammarType === "unary_expression" || l_node.grammarType === "parenthesized_expression" || l_node.grammarType === "cast_expression" || l_node.grammarType === "field_expression") {
        if (l_node.grammarType === "cast_expression") {
            l_node = l_node.namedChild(1);
        }
        else {
            l_node = l_node.namedChild(0);
        }
    }

    while (r_node.grammarType === "unary_expression" || r_node.grammarType === "parenthesized_expression" || r_node.grammarType === "cast_expression" || r_node.grammarType === "field_expression") {
        if (r_node.grammarType === "cast_expression") {
            r_node = r_node.namedChild(1);
        }
        else {
            r_node = r_node.namedChild(0);
        }
    }

    if (l_node.grammarType === "binary_expression") {
        flag1 = binary_handle(l_node, depth);
    }
    else if (l_node.grammarType === "identifier") {
        create(queried, l_node.text, "null", depth)
    }
    else if (l_node.grammarType === "subscript_expression") {
        flag1 = subscript_handle(l_node, depth, queried)
    }
    else if (l_node.grammarType === "number_literal" || l_node.grammarType === "string_literal" || l_node.grammarType === "char_literal" || l_node.grammarType === "false" || l_node.grammarType === "true") {
        // pass
    }
    else {
        err("Element not found!");
        err(l_node.grammarType);
        return false;
    }

    if (r_node.grammarType === "binary_expression") {
        flag1 = binary_handle(r_node, depth);
    }
    else if (r_node.grammarType === "identifier") {
        create(queried, r_node.text, "null", depth)
    }
    else if (r_node.grammarType === "subscript_expression") {
        flag1 = subscript_handle(r_node, depth, queried)
    }
    else if (r_node.grammarType === "number_literal" || r_node.grammarType === "string_literal" || r_node.grammarType === "char_literal" || r_node.grammarType === "false" || r_node.grammarType === "true") {
        // pass
    }
    else {
        err("Element not found!");
        err(r_node.grammarType);
        return false;
    }
    return flag1 && flag2;
}

function condition_handle(node: any, depth: number): boolean {
    let flag = true;
    if (!status.conditional) {
        status.conditional = true;
        experiences = experiences + conditionalPrompt;
    }
    return flag;
}

function if_handle(node: any, depth: number): boolean {
    let flag1 = true;
    let flag2 = true;
    let flag3 = true;
    flag1 = binary_handle(node.namedChild(0).namedChild(0), depth);
    if (node.namedChild(1).grammarType === "compound_statement") {
        flag2 = compound_handle(node.namedChild(1), depth);
    }
    else if (node.namedChild(1).grammarType === "expression_statement") {
        flag2 = statement_handle(node.namedChild(1), depth)
    }
    else {
        flag2 = false;
        err("if_flag2");
        err(node.namedChild(1).grammarType);
    }

    if (node.namedChildCount > 2) {
        if (node.namedChild(2).namedChild(0).grammarType === "if_statement") {
            flag3 = if_handle(node.namedChild(2).namedChild(0), depth);
        }
        else if (node.namedChild(2).namedChild(0).grammarType === "compound_statement") {
            flag3 = compound_handle(node.namedChild(2).namedChild(0), depth)
        }
        else if (node.namedChild(2).namedChild(0).grammarType === "expression_statement") {
            flag3 = statement_handle(node.namedChild(2).namedChild(0), depth);
        }
        else {
            flag3 = false;
            err("if_flag3");
            err(node.namedChild(2).namedChild(0).grammarType);
        }
    }
    return flag1 && flag2 && flag3;
}

function call_handle(node: any, depth: number): boolean {
    par = true;
    let tmp = node.namedChild(1);
    let flag = true;
    for (let i = 0; i < tmp.namedChildCount; i++) {
        let nn = tmp.namedChild(i);
        if (nn.grammarType === "cast_expression") {
            nn = nn.namedChild(1);
        }
        if (nn.grammarType === "identifier") {
            create(queried, tmp.namedChild(i).text, "null", depth);
        }
        else if (nn.grammarType === "subscript_expression") {
            flag = subscript_handle(tmp.namedChild(i), depth, queried)
        }
        else if (nn.grammarType === "binary_expression") {
            flag = binary_handle(tmp.namedChild(i), depth)
        }
        else if (nn.grammarType === "pointer_expression") {
            flag = false;
            err("pointer inside call");
        }
        else if (nn.grammarType === "number_literal") {
            //pass
        }
        else {
            err("Argument type not found!");
            err("type: " + tmp.namedChild(i).grammarType);
            err("name: " + tmp.namedChild(i).text);
            return false;
        }
        if (!flag) {
            break;
        }
    }
    return false;
}

function create(table: tab, name: string, index: any, depth: number) {
    let place = table["name"].length;
    table["name"][place] = name;
    table["index"][place] = index;
    table["depth"][place] = depth;
}

function find(table: tab, name: string, index: any, depth: number) {
    for (let i = 0; i < table["name"].length; i++) {
        if (table["name"][i] === name && table["index"][i] === index) {
            if (depth === -1 || table["depth"][i] === depth || table["depth"][i] === "null") {
                return true;
            }
        }
    }
    return false;
}
//=1
function del(name: string) {
    for (let i = 0; i < reduction_count["name"].length; i++) {
        if (reduction_count["name"][i] === name) {
            reduction_count["name"].splice(i, 1);
            reduction_count["index"].splice(i, 1);
            reduction_count["depth"].splice(i, 1);
            return true;
        }
    }
    return false;
}

function PnR(l_node: any, r_node: any, index: any, depth: number): boolean {
    if (find(assigned, l_node, index, depth)) {
        //pass 
    }
    else if (find(queried, l_node, index, depth)) {
        err("Dependency!");
        return false;
    }
    else {
        if (!status.private) {
            status.private = true;
            experiences = experiences + privatePrompt;
        }
    }
//text-----------------------------------------
    if (!(find(no_reduction, l_node, "null", -1) || find(assigned, l_node, "null", -1))) {
        if (r_node.indexOf(l_node) !== -1) {
            if (del(l_node)) {
                create(no_reduction, l_node, "null", -1);
            }
            else {
                create(reduction_count, l_node, "null", -1);
            }
        }
    }
    return true;
}

function binary_changed(node: any, depth: number) {
    let l_node = node.namedChild(0);
    let r_node = node.namedChild(1);

    if (changed(l_node, depth) || changed(r_node, depth)) {
        return true;
    }
    else {
        return false;
    }
}

function changed(index: any, depth: number): boolean {
    let flag = false;
    if (depth > 1 && index.text === status.indexx) {
        flag = true;
    }
    else if (index.grammarType === "identifier") {
        flag = find(assigned, index.text, "null", -1);
    }
    else if (index.grammarType === "subscript_expression") {
        let sub_table: any[] = [];
        get_sub(index, sub_table);
        //sub_table[1]
        if (find(assigned, sub_table[0].text, sub_table, -1)) {
            flag = true;
        }
        else {
            for (let i = 1; i < sub_table.length; i++) {
                flag = changed(sub_table[i], depth + 1);
                if (flag) {
                    break;
                }
            }
        }
    }
    else if (index.grammarType === "binary_expression") {
        flag = binary_changed(index, depth);
    }
    else if (index.grammarType === "number_literal") {
        flag = false;
    }
    else {
        err("Subscript type not found!");
        flag = true;
    }
    return flag;
}

function test() {
    console.log(status["errmsg"]);
    for (let i = 0; i < assigned["name"].length; i++) {
        if (assigned["index"][i] === "null") {
            console.log("variable: " + assigned["name"][i]);
        }
        else {
            //=2
            console.log("variable: " + assigned["name"][i]);
            for (let j = 1; j < assigned["index"][i].length; j++) {
                console.log("[");
                console.log(assigned["index"][i][j].text);
                console.log("]");
            }
            console.log("\n");
        }
    }
    console.log("//////////////////////////////////////////////-");
    //=1
    for (let i = 0; i < queried["name"].length; i++) {
        if (queried["index"][i] === "null") {
            console.log("variable: " + queried["name"][i]);
        }
        else {
            console.log("variable: " + queried["name"][i]);
            //=2
            for (let j = 1; j < queried["index"][i].length; j++) {
                console.log("[");
                console.log(queried["index"][i][j].text);
                console.log("]");
            }
            console.log("\n");
        }
    }
    console.log("//////////////////////////////////////////////-");
    if (status.private) {
        console.log("private");
    }
    if (status.reduction) {
        console.log("reduction");
    }
    if (status.nested) {
        console.log("nested");
    }
    if (status.conditional) {
        console.log("conditional");
    }
}

function init() {
    status["nested"] = false;
    status["private"] = false;
    status["update"] = false;
    status["reduction"] = false;
    status["conditional"] = false;
    status["indexx"] = "";
    status["errmsg"] = "This loop is not parallelizable!\n";
    experiences = "";
    par = true;
    assigned = { name: [], index: [], depth: [] };
    queried = { name: [], index: [], depth: [] };
    reduction_count = { name: [], index: [], depth: [] };
    no_reduction = { name: [], index: [], depth: [] };
}

function diff(A: any, B: any) {
    let flag = false;
    //=1
    for (let i = 0; i < A.length; i++) {
        if (A[i].grammarType === "number_literal" && B[i].grammarType === "number_literal" && A[i].text !== B[i].text) {
            return false;
        }
        if (changed(A[i], 2)) {
            if (A[i].text !== B[i].text) {
                return true;
            }
        }
        else {
            if (A[i].text === B[i].text) {
                // pass
            }
        }
    }
    return flag;
}

function sub_check() {
    //=1
    console.log(assigned);
    console.log(queried);
    for (let i = 0; i < assigned["name"].length; i++) {
        for (let j = 0; j < queried["name"].length; j++) {
            if (assigned["name"][i] === queried["name"][j]) {
                // 只有当两个访问都是数组访问（索引不为null）且索引表达式不同时才是真正的数据依赖
                const assignedIsArray = assigned["index"][i] !== "null";
                const queriedIsArray = queried["index"][j] !== "null";
                
                // 真正的数据依赖：同一个数组的不同索引访问
                if (assignedIsArray && queriedIsArray && diff(assigned["index"][i], queried["index"][j])) {
                    return true;
                }
            }
        }
    }
    return false;
}

function err(str: string) {
    status["errmsg"] = status["errmsg"] + str + "\n";
}