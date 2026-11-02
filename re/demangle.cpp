#include <cxxabi.h>
#include <iostream>
#include <cstdlib>
int main(){
    int rc=0;
    char* fn=nullptr;
    std::string line;
    while(std::getline(std::cin,line)){
        if(line.empty()) continue;
        fn = abi::__cxa_demangle(line.c_str(),0,0,&rc);
        std::cout << (fn? fn : line) << "\n";
        if(fn) free(fn);
    }
    return 0;
}
