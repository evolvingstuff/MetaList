from setuptools import setup, find_packages


def read_requirements():
    with open('requirements.txt') as req:
        return req.read().splitlines()


with open('README.md', 'r', encoding='utf-8') as fh:
    long_description = fh.read()


setup(
    name='MetaList',
    version='0.1.0',
    author='Thomas Lahore',
    author_email='tom.lahore@gmail.com',
    description='A PKM web app that integrates with LLMs',
    long_description=long_description,
    long_description_content_type='text/markdown',
    url='https://github.com/yourusername/metalist',
    packages=find_packages(),
    include_package_data=True,
    install_requires=read_requirements(),
    classifiers=[
        'Programming Language :: Python :: 3',
        'Programming Language :: Python :: 3.8',
        'License :: OSI Approved :: MIT License',
        'Operating System :: OS Independent',
        'Intended Audience :: Developers',
        'Topic :: Software Development :: Libraries',
    ],
    entry_points={
        'console_scripts': [
            'metalist=metalist.app:main'
        ],
    },
    python_requires='>=3.8',
)