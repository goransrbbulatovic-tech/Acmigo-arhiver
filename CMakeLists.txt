cmake_minimum_required(VERSION 3.15)
project(archive_addon CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# --- Node/Electron headeri (postavlja cmake-js) ---
include_directories(${CMAKE_JS_INC})

file(GLOB SOURCE_FILES "native/src/*.cpp")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

# --- node-addon-api (header-only C++ omotač) ---
execute_process(
  COMMAND node -p "require('node-addon-api').include_dir"
  WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}
  OUTPUT_VARIABLE NODE_ADDON_API_DIR
  OUTPUT_STRIP_TRAILING_WHITESPACE)
target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_ADDON_API_DIR})
add_definitions(-DNAPI_VERSION=8)

# --- libarchive preko pkg-config ---
# U CI-ju vcpkg (static) postavlja PKG_CONFIG_PATH kroz toolchain.
# Za lokalni razvoj pomažemo da nađe keg-only brew libarchive.
if(NOT DEFINED VCPKG_TARGET_TRIPLET)
  if(EXISTS "/opt/homebrew/opt/libarchive/lib/pkgconfig")
    set(ENV{PKG_CONFIG_PATH} "/opt/homebrew/opt/libarchive/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
  elseif(EXISTS "/usr/local/opt/libarchive/lib/pkgconfig")
    set(ENV{PKG_CONFIG_PATH} "/usr/local/opt/libarchive/lib/pkgconfig:$ENV{PKG_CONFIG_PATH}")
  endif()
endif()

find_package(PkgConfig REQUIRED)
pkg_check_modules(ARCHIVE REQUIRED libarchive)
target_include_directories(${PROJECT_NAME} PRIVATE ${ARCHIVE_INCLUDE_DIRS})

# Kad je libarchive statičan (vcpkg), povuci i sve tranzitivne zavisnosti
# (zlib, bzip2, lzma, zstd, lz4, iconv...). pkg-config ih daje u *_STATIC_*.
if(ARCHIVE_STATIC_LIBRARIES AND DEFINED VCPKG_TARGET_TRIPLET)
  target_link_directories(${PROJECT_NAME} PRIVATE ${ARCHIVE_STATIC_LIBRARY_DIRS})
  target_link_libraries(${PROJECT_NAME} ${ARCHIVE_STATIC_LIBRARIES})
else()
  target_link_directories(${PROJECT_NAME} PRIVATE ${ARCHIVE_LIBRARY_DIRS})
  target_link_libraries(${PROJECT_NAME} ${ARCHIVE_LIBRARIES})
endif()

target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})

# napi_* simbole obezbjeđuje host (node/electron) u runtime-u
if(APPLE)
  target_link_options(${PROJECT_NAME} PRIVATE -undefined dynamic_lookup)
endif()
